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
export { assembleSnapshot } from "./assemble-snapshot.ts";
export { loadMapping, mapVerdict, type Mapping, type AcsDecision } from "./map-verdict.ts";
