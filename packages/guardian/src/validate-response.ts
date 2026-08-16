/**
 * N21's outbound twin, and the gap it closes was §V7's to find: inbound
 * requests are checked against all 43 v0.1.0 schemas and responses were
 * hand-built objects checked by nothing. A conformance harness publishing a
 * matrix over that wire would have been measuring a format that was never
 * itself contract-checked -- which weakens exactly the claim C2 exists to
 * prove.
 *
 * THREE ANSWERS, NOT TWO, and the third is a measured fact about v0.1.0
 * rather than a hedge. `response-envelope.json` declares `result` as an
 * unconditional `$ref` to `AcsResult`, and `AcsResult` requires `decision`.
 * A ServerHello has no `decision`. So a correct handshake response cannot
 * satisfy the response envelope schema, and a two-answer validator would have
 * to call a correct response invalid or skip it in silence. `unexpressible`
 * says which, and carries the reason into the envelope log where the
 * Inspector renders it. V7's matrix carries the same cell.
 *
 * REPORTS, NEVER THROWS, and never alters the response. This runs on the
 * decision path; a validator that could turn a governed tool call into an
 * error response would be a fail-open of exactly the family this project
 * keeps closing. A response that fails validation is still sent, and the
 * failure is recorded.
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
 * call later, on the way out instead of the way in. The try/catch below is
 * what makes "reports, never throws" true for a broken deployment and not
 * only for a well-formed one.
 */
import { getValidator } from "./validate-envelope.ts";

export type ResponseValidation =
  | { valid: true }
  | { valid: false; pointer: string; message: string }
  | { valid: "unexpressible"; reason: string };

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

export function validateResponse(response: unknown): ResponseValidation {
  if (isServerHelloResponse(response)) {
    return { valid: "unexpressible", reason: HANDSHAKE_UNEXPRESSIBLE };
  }
  try {
    const validate = getValidator(RESPONSE_ENVELOPE_SCHEMA_ID);
    if (validate(response)) {
      return { valid: true };
    }
    const first = validate.errors?.[0];
    return {
      valid: false,
      pointer: first?.instancePath ?? "",
      message: first ? `${first.instancePath || "/"} ${first.message}` : "response failed validation",
    };
  } catch (error) {
    // getValidator's own registry build is not total -- see this module's
    // doc comment. Caught here, not left to propagate, for the same reason
    // every other total component on this decision path catches its own
    // failure rather than trusting a caller to: server.ts calls this
    // function with nothing above it left to catch a second throw.
    const message = error instanceof Error ? error.message : String(error);
    return { valid: false, pointer: "", message: `validateResponse could not check the response: ${message}` };
  }
}
