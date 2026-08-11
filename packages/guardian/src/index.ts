/**
 * Public surface of the guardian package: the governance verbs, and nothing
 * else.
 *
 * S6's writer (N26, ./envelope-tap.ts) is deliberately NOT re-exported.
 * Observability is an internal detail of running a Guardian, not part of the
 * vocabulary a consumer of this package speaks -- and a barrel that mixes
 * `startGuardian` / `mapVerdict` with `createEnvelopeLogSink` /
 * `NULL_ENVELOPE_LOG_SINK` / `extractRpcId` / the entry types makes the
 * second look like the first (PR #11 review). The one affordance a consumer
 * actually needs is `envelopeLogPath` on `StartGuardianOptions`, which stays
 * exactly where it was: you tell a Guardian where to write S6, you do not
 * assemble its sink yourself.
 *
 * Nothing outside this package imported those names, so this removes a
 * public surface rather than a dependency: `./server.ts` imports the sink
 * directly, and the two test files that exercise N26 on its own
 * (`packages/guardian/test/envelope-tap*.test.ts`) import
 * `../src/envelope-tap.ts` directly, which is the arrangement they already
 * used. If an external writer of S6 ever becomes a real use case, the
 * honest answer is a narrow subpath export, not putting it back here.
 *
 * The Inspector is unaffected either way -- it imports NOTHING from this
 * package (R5.1), reads S6 as a file, and re-declares `EnvelopeLogEntry`
 * itself; `test/invariants.test.ts` gates that and
 * `test/envelope-tap-roundtrip.test.ts` keeps the two declarations honest.
 */
export { startGuardian, type StartGuardianOptions, type StartedGuardian } from "./server.ts";
export { buildServerHello, type ServerHello } from "./handshake.ts";
export {
  validateEnvelope,
  isToolCallRequest,
  EnvelopeValidationError,
  type AcsRequestEnvelope,
  type ToolCallRequestEnvelope,
} from "./validate-envelope.ts";
export { assemblePreToolCallSnapshot, type AgtPreToolCallSnapshot } from "./assemble-snapshot.ts";
export { loadMapping, mapVerdict, type Mapping, type AcsDecision } from "./map-verdict.ts";
