/** Public surface of the guardian package. */
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
export {
  createEnvelopeLogSink,
  extractRpcId,
  NULL_ENVELOPE_LOG_SINK,
  type CreateEnvelopeLogSinkOptions,
  type EnvelopeLogDirection,
  type EnvelopeLogEntry,
  type EnvelopeLogSink,
} from "./envelope-tap.ts";
