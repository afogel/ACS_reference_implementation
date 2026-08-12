/**
 * The Guardian client (N4): the adapter's wire seam. `createGuardianClient`
 * binds one ACS endpoint and returns the role a caller collaborates with.
 *
 * TWO METHODS, AND WHY THE SECOND EXISTS (PR #10 review, Important). This used
 * to be a one-method namespace returning a raw JSON-RPC response, and the host
 * shim then dug through it: read `.error`, throw if present, cast `.result`
 * into a decision shape and hope. That inspection is where "a decision that
 * arrived outranks anything else" lives, so leaving it in a host shim meant
 * the next host (slice V5) would copy it -- and copying it wrong is a
 * fail-open, because every branch that gets a decision wrong ends with the
 * tool call proceeding ungoverned.
 *
 * So `requestDecision` is *told* to fetch the decision for an envelope and
 * answers with a message -- `DecisionOrFailure` -- rather than a bag. It never
 * throws: every way of not getting a decision (a dead transport, an
 * uncorrelated response, a JSON-RPC error, a result naming no decision) is the
 * same one answer, "no decision arrived, and here is what stands in its
 * place". A caller cannot forget to handle one.
 *
 * `post` stays as the wire primitive underneath it, for the one caller whose
 * method's result is not a decision: the handshake, whose result is a
 * ServerHello (handshake.ts). It throws on every delivery failure, which is
 * what that caller wants -- a handshake failure is not a step's failure and
 * travels separately.
 *
 * V1 SCOPE: what a host DOES with `decisionArrived: false` is not decided
 * here and is not decided at this slice. Negotiating and applying a
 * fail-open/fail-closed posture is N6/N7, deliberately deferred to V3; the
 * shim's current handling is a placeholder its own header documents as one.
 * This module's contribution is only that the failure arrives as one answer
 * instead of a bag every caller re-interprets.
 *
 * Correlation note (Task 7 -> Task 8): buildEnvelope sets the envelope's
 * top-level `id` equal to `params.request_id` (a fresh uuid per call).
 * That is sufficient here: `id` is schema-legal as a string (per
 * request-envelope.json, `id` is `oneOf` string/number, with no format
 * constraint of its own), and since `fetch` already pairs this exact HTTP
 * request with this exact HTTP response one-to-one, there is no
 * multiplexing problem to solve. The id check below is a defensive
 * assertion -- it catches a Guardian bug that echoes back the wrong id --
 * not a lookup table matching concurrent in-flight requests. Nothing about
 * Task 7's choice needs to change.
 *
 * R3.2: this module knows JSON-RPC, HTTP and ACS's decision vocabulary,
 * nothing else -- no policy-runtime vocabulary and no host vocabulary. It has
 * no runtime dependency on the Guardian or policy-bridge packages -- it talks
 * to the Guardian only over the wire, at whatever `url` the caller gives.
 */
import type { AcsRequestEnvelope } from "./build-envelope.ts";
import type { AcsDecision } from "./decision-message.ts";

/**
 * The minimal JSON-RPC 2.0 request shape this client sends -- the TRANSPORT
 * shape, used by `post` alone.
 *
 * Loose on `params` on purpose: `post` carries whatever a caller hands it, and
 * its one non-decision caller is the handshake, whose ClientHello params are
 * not an ACS request at all.
 *
 * NOT the shim-facing vocabulary (PR #10 review, second pass). `requestDecision`
 * used to take one of these, so the seam between a producer speaking
 * `AcsRequestEnvelope` and a consumer speaking `AcsDecision` was the one place
 * the ACS noun evaporated and JSON-RPC's took its place. It now takes the ACS
 * request message, and this stays the internal transport type underneath it.
 */
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  method: string;
  id: string | number;
  params: Record<string, unknown>;
};

export type JsonRpcSuccessResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: Record<string, unknown>;
  error?: undefined;
};

export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: undefined;
  error: { code: number; message: string; data?: unknown };
};

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Thrown when the Guardian's response id doesn't match the request's --
 * i.e. the response cannot be trusted to belong to this request. */
export class GuardianResponseMismatchError extends Error {
  constructor(requestId: string | number, responseId: string | number | null) {
    super(
      `GuardianClient.post: response id ${JSON.stringify(responseId)} does not correlate with request id ${JSON.stringify(requestId)}`,
    );
    this.name = "GuardianResponseMismatchError";
  }
}

/**
 * What came back when a decision was asked for. Exactly one of the two cases,
 * discriminated by the only question that matters at this seam: did a decision
 * arrive?
 *
 *   - `decisionArrived: true` -- one did. What the Guardian sent, unvalidated.
 *   - `decisionArrived: false` -- none did, and `failure` is whatever stands
 *     in its place: the throw from the wire, the JSON-RPC `error` object the
 *     Guardian answered with, or (for a response carrying neither) an Error
 *     saying so.
 *
 * A union rather than a bag with optional fields, so a caller that reads
 * `decision` without checking does not compile.
 */
export type DecisionOrFailure =
  | { readonly decisionArrived: true; readonly decision: AcsDecision }
  | { readonly decisionArrived: false; readonly failure: unknown };

/**
 * The Guardian, as the adapter's callers depend on it: a role bound to one ACS
 * endpoint, not a URL passed around and a namespace of free functions.
 */
export type GuardianClient = {
  /**
   * Asks for the decision on `envelope` and answers with a message. Never
   * throws -- see DecisionOrFailure.
   *
   * Takes the ACS request message and answers with an ACS decision: both ends of
   * this method are ACS's vocabulary, and JSON-RPC is the transport it happens to
   * travel over (see JsonRpcRequest).
   */
  requestDecision(envelope: AcsRequestEnvelope): Promise<DecisionOrFailure>;
  /**
   * The wire primitive: POSTs `envelope` as JSON, parses the JSON-RPC
   * response, and returns it once its `id` is confirmed to match the
   * request's. Throws for every delivery failure.
   *
   * For a method whose result is not a decision -- today only
   * `handshake/hello`, whose result is a ServerHello. A caller after a
   * decision uses `requestDecision` instead, and no caller in this package
   * inspects a response for one.
   */
  post(envelope: JsonRpcRequest): Promise<JsonRpcResponse>;
};

/** Binds a Guardian's ACS endpoint and returns the client role for it. */
export function createGuardianClient(url: string): GuardianClient {
  async function post(envelope: JsonRpcRequest): Promise<JsonRpcResponse> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });

    const response = (await res.json()) as JsonRpcResponse;

    if (response.id !== envelope.id) {
      throw new GuardianResponseMismatchError(envelope.id, response.id);
    }

    return response;
  }

  return {
    post,

    async requestDecision(envelope: AcsRequestEnvelope): Promise<DecisionOrFailure> {
      let response: JsonRpcResponse;
      try {
        response = await post(envelope);
      } catch (failure) {
        // A dead transport, an uncorrelated response, a body that is not JSON.
        // None of them carry a decision, so all of them are the same answer --
        // and turning the throw into that answer here is what stops a caller's
        // catch block from having to work out which stage of its own sequence
        // threw.
        return { decisionArrived: false, failure };
      }

      // An arriving decision is checked for FIRST. A JSON-RPC response
      // carrying both `error` and `result` is malformed per JSON-RPC, but if
      // the `result` names a decision then a decision did arrive, and an
      // arriving `deny` must be honoured -- answering it with a failure
      // instead would let a delivery-failure rule overrule a policy decision.
      const arrived = response.result as AcsDecision | undefined;
      if (typeof arrived?.decision === "string") {
        return { decisionArrived: true, decision: arrived };
      }

      // Anything with no decision in it is a delivery failure, and the `error`
      // is used as the failure when there is one.
      return {
        decisionArrived: false,
        failure: response.error ?? new Error("guardian's response carried neither a decision nor an error"),
      };
    },
  };
}
