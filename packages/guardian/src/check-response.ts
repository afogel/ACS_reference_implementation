/**
 * This module is validateEnvelope's outbound counterpart. It closes a gap:
 * inbound requests are compiled against three schemas (request-envelope.json
 * and, method-gated, the two hook payload schemas -- all 43 are registered so
 * `$ref`s resolve, but only those three are ever compiled) and responses
 * were hand-built objects checked by nothing. A conformance harness
 * publishing a matrix over that wire would have been measuring a format
 * that was never itself contract-checked -- which weakens exactly the claim
 * the coverage matrix exists to prove: that ACS v0.1.0's expressiveness
 * against AGT is checked case by case, not merely asserted.
 *
 * FOUR STATUSES, AND EACH NAMES A DIFFERENT FACT. They are a status, not
 * values of a boolean called `valid`, because two of them are not answers
 * about validity at all:
 *
 *   checked_valid     compiled against the schema, and satisfied it.
 *   checked_invalid   compiled against the schema, and did not.
 *   unexpressible     v0.1.0 has no shape this response could satisfy, so
 *                     there was nothing to compile it against.
 *   unchecked         the schema registry could not be built, so no
 *                     comparison happened.
 *
 * The last two were previously folded into `valid: false`, which said the
 * response had been checked and rejected. "Never checked" and "checked and
 * rejected" are different facts about a response the Guardian is about to
 * send, and a deployment reading the first as the second would be chasing a
 * schema violation that was never observed.
 *
 * `unexpressible` is a measured fact about v0.1.0 rather than a hedge.
 * `response-envelope.json` declares `result` as an unconditional `$ref` to
 * `AcsResult`, and `AcsResult` requires `decision`. A ServerHello has no
 * `decision`. So a correct handshake response cannot satisfy the response
 * envelope schema, and a two-answer validator would have to call a correct
 * response invalid or skip it in silence. server.ts reports it on the same
 * stderr line shape as an invalid response -- naming the method and this
 * reason -- so the answer is recorded rather than computed and dropped; it
 * is not written into the envelope log (`envelope-log-sink.ts`). That
 * entry's shape (`EnvelopeLogEntry`) is left narrower on purpose, and the
 * Inspector already reads it -- carrying a check result onto that wire, so
 * the Inspector could render it directly instead of an operator reading
 * stderr, is future work this module does not attempt.
 *
 * This status is NOT a coverage-matrix cell and must not be described as
 * one. A matrix cell is an AGT intervention point against an AGT verdict;
 * `handshake/hello` is neither, and the matrix's own `CellStatus` has
 * `unexpressed`, a different word for a different axis. Letting one
 * measurement stand in for another is exactly the confusion this project
 * keeps apart, and it must not happen inside the module that exists to make
 * the matrix's wire trustworthy.
 *
 * REPORTS, NEVER THROWS, and never alters the response -- which is why the
 * verb is `check` rather than `validate`. Inbound, `validateEnvelope`
 * throws and the request stops. This runs on the decision path, after the
 * decision is made; a check that could turn a governed tool call into an
 * error response would be a fail-open of exactly the family this project
 * keeps closing. A response that fails is still sent, and the failure is
 * recorded. `ResponseCheck` is the twin of the conformance harness's
 * `SchemaLegResult`, which reports `{ran: false, reason}` for the same
 * reason: whether a check ran is a fact it has to be able to state.
 *
 * The Ajv instance is validate-envelope.ts's own, reached through its
 * exported `getValidator(schemaId)` rather than rebuilt here: both modules
 * load the same 43 schemas from the same SCHEMA_ROOT, so building a second
 * registry would mean two loads of the same files and two places a future
 * edit to the loading logic would have to land in step. Sharing the lookup
 * function makes that agreement structural rather than a convention two
 * files happen to follow.
 *
 * `getValidator` itself is not total -- it throws when the schema registry
 * cannot be built at all (a tree cloned without `--recurse-submodules`,
 * server.ts's own header names this exact case for the inbound side), and
 * `test/server.test.ts`'s `withSchemalessGuardian` reproduces it for real:
 * relocating a copy of this package one directory deeper makes SCHEMA_ROOT
 * resolve to a path that does not exist, and `readdirSync` throws ENOENT.
 * On the inbound side that throw is caught by `dispatch` and turned into a
 * parseable JSON-RPC error; this function is called AFTER that recovery,
 * immediately before the response is sent, with nothing above it in
 * server.ts to catch a second throw -- so if this function let one escape,
 * the exact fail-open server.ts's header exists to prevent would reopen one
 * call later, on the way out instead of the way in. `unchecked` is what
 * makes "reports, never throws" true for a broken deployment and not only
 * for a well-formed one.
 */
import { getValidator } from "./validate-envelope.ts";

export type ResponseCheck =
  | { status: "checked_valid" }
  | { status: "checked_invalid"; pointer: string; message: string }
  | { status: "unexpressible"; reason: string }
  | { status: "unchecked"; reason: string };

const HANDSHAKE_UNEXPRESSIBLE =
  "response-envelope.json's `result` unconditionally $refs AcsResult, which requires `decision`; " +
  "a ServerHello has no such field, so v0.1.0 has no discriminated union for non-decision methods";

const RESPONSE_ENVELOPE_SCHEMA_ID = "https://acs.org/schema/v0.1.0/response-envelope.json";

/**
 * Tests for a `result` that is an object with no `decision` member AND a
 * `methods_evaluated` member -- the ServerHello's own required field per
 * handshake.json -- rather than for the absence of `decision` alone. A
 * decision response that merely lost its `decision` (a malformed
 * `AcsResult`) has no `methods_evaluated` either, so testing for absence of
 * `decision` by itself would excuse it as unexpressible instead of reporting
 * it invalid, which is the one thing this validator exists to catch.
 */
function isServerHelloResponse(response: unknown): boolean {
  if (typeof response !== "object" || response === null || !("result" in response)) {
    return false;
  }
  const result = (response as { result: unknown }).result;
  if (typeof result !== "object" || result === null) {
    return false;
  }
  return !("decision" in result) && "methods_evaluated" in result;
}

export function checkResponse(response: unknown): ResponseCheck {
  // isServerHelloResponse is inside the try too -- "reports, never throws" is
  // stated as this function's whole contract, not as a property of the parts
  // that happen to call into Ajv, so nothing in this body is allowed to sit
  // outside the one guard that makes the contract true.
  try {
    if (isServerHelloResponse(response)) {
      return { status: "unexpressible", reason: HANDSHAKE_UNEXPRESSIBLE };
    }
    const validate = getValidator(RESPONSE_ENVELOPE_SCHEMA_ID);
    if (validate(response)) {
      return { status: "checked_valid" };
    }
    const first = validate.errors?.[0];
    return {
      status: "checked_invalid",
      pointer: first?.instancePath ?? "",
      message: first ? `${first.instancePath || "/"} ${first.message}` : "response failed validation",
    };
  } catch (error) {
    // getValidator's own registry build is not total -- see this module's
    // doc comment. Caught here, not left to propagate, for the same reason
    // every other total component on this decision path catches its own
    // failure rather than trusting a caller to: server.ts calls this
    // function with nothing above it left to catch a second throw.
    //
    // Its own status, not `checked_invalid`. This response was never
    // compared against response-envelope.json, and saying it failed the
    // comparison would send an operator looking for a schema violation
    // nothing observed.
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unchecked",
      reason: `the schema registry could not be built: ${message}`,
    };
  }
}
