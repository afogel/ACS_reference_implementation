/**
 * The Guardian client: the adapter's wire seam. `createGuardianClient` binds
 * one ACS endpoint and returns the role a caller collaborates with.
 *
 * Two methods, because two callers want opposite things from a failure:
 *
 *   - `requestDecision` never throws. Every way of not getting a decision --
 *     a dead transport, an uncorrelated response, a JSON-RPC error, a result
 *     naming no decision -- becomes the same answer, so a caller cannot forget
 *     to handle one. Getting that wrong is a fail-open, because every branch
 *     that mishandles a decision ends with the tool call proceeding ungoverned.
 *   - `post` is the wire primitive underneath it, for the one caller whose
 *     result is not a decision: the handshake, whose result is a ServerHello
 *     (handshake.ts). It throws on every delivery failure, which is what that
 *     caller wants -- a handshake failure is not a step's failure and travels
 *     separately.
 *
 * What a host DOES with `decisionArrived: false` -- negotiating and applying a
 * fail-open or fail-closed posture -- is not decided here.
 *
 * Correlation happens at two layers, because the two say different things.
 * buildEnvelope sets the envelope's top-level `id` equal to
 * `params.request_id`. `fetch` already pairs one HTTP request with one
 * response, so the transport-id check below is a defensive assertion against
 * a Guardian that echoes back the wrong id, not a lookup table for concurrent
 * requests. The ACS layer is a separate claim: `result.request_id` names the
 * step the decision is ABOUT, and matching transport ids say nothing about
 * it -- a Guardian, or anything else that reaches an unauthenticated socket,
 * can answer with the right `id` and another step's decision. Both are
 * checked, and both are checked in `post`, so no caller can hold a response
 * that was never correlated.
 *
 * This module knows JSON-RPC, HTTP and ACS's decision vocabulary, nothing else
 * -- no policy-runtime vocabulary and no host vocabulary. It has no runtime
 * dependency on the Guardian or policy-bridge packages: it talks to the
 * Guardian only over the wire, at whatever `url` the caller gives.
 */
import type { AcsRequestEnvelope } from "./build-envelope.ts";
import type { AcsDecision } from "./decision-message.ts";

/**
 * The minimal JSON-RPC 2.0 request shape this client sends -- the transport
 * shape, used by `post` alone, not the shim-facing vocabulary.
 *
 * Loose on `params` on purpose: `post` carries whatever a caller hands it, and
 * its one non-decision caller is the handshake, whose ClientHello params are
 * not an ACS request at all.
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

/** Thrown when the Guardian's response correlates at the transport layer but
 * its ACS result names a different request -- i.e. a real decision, about
 * some other step. A sibling of GuardianResponseMismatchError rather than the
 * same error: the transport id matching and the ACS request_id matching are
 * different claims, and a reader of the message needs to know which one the
 * Guardian broke. */
export class GuardianResultCorrelationError extends Error {
  constructor(requestId: unknown, resultRequestId: unknown) {
    super(
      `GuardianClient.post: result.request_id ${JSON.stringify(resultRequestId)} does not correlate with the request's request_id ${JSON.stringify(requestId)}`,
    );
    this.name = "GuardianResultCorrelationError";
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
   * response, and returns it once it is confirmed to answer this request --
   * at the transport layer by `id`, and, when the result carries one, at the
   * ACS layer by `request_id`. Throws for every delivery failure.
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

    // The ACS-layer claim, checked only when a result makes it: a ServerHello
    // and a JSON-RPC error carry no request_id, and neither is broken here.
    // `undefined !== envelope.params.request_id` would fire on a handshake,
    // so the guard is on the result's field, not on the envelope's.
    const resultRequestId = (response.result as { request_id?: unknown } | undefined)?.request_id;
    if (resultRequestId !== undefined && resultRequestId !== envelope.params.request_id) {
      throw new GuardianResultCorrelationError(envelope.params.request_id, resultRequestId);
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
