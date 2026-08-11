/**
 * Public surface of the host-adapter package (packages/host-adapter).
 *
 * Every host shim imports from here rather than from individual src files,
 * so this list is the whole contract a shim relies on. The package boundary
 * still binds every file this barrel re-exports: no policy-runtime vocabulary
 * of any kind anywhere under packages/host-adapter/.
 */
export {
  buildEnvelope,
  loadHookmap,
  toSessionUuid,
  unwrapArguments,
  type Hookmap,
  type HookmapHookEntry,
  type AcsRequestEnvelope,
} from "./build-envelope.ts";
export {
  createGuardianClient,
  GuardianResponseMismatchError,
  GuardianResultCorrelationError,
  GuardianTimeoutError,
  type DecisionOrFailure,
  type GuardianClient,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
  type PostOptions,
} from "./guardian-client.ts";
export { renderDecision, type HostOutput } from "./render-decision.ts";
export { type AcsDecision } from "./decision-message.ts";
export {
  negotiateSessionConfig,
  SessionConfigNotStoredError,
  type HandshakeOptions,
} from "./handshake.ts";
export {
  createSessionConfigStore,
  createFileSessionConfigStore,
  isSessionConfig,
  InvalidSessionIdError,
  sessionConfigPath,
  type SessionConfig,
  type SessionConfigStore,
  type CreateFileSessionConfigStoreOptions,
} from "./session-config.ts";
export {
  createAuditSink,
  NULL_AUDIT_SINK,
  type AuditEntry,
  type AuditSink,
  type CreateAuditSinkOptions,
} from "./audit-sink.ts";
export {
  applyFailurePosture,
  classifyDeliveryFailure,
  DEFAULT_POSTURE,
  DEFAULT_TIMEOUT_MS,
  type ApplyFailurePostureInput,
  type DeliveryFailureKind,
  type PostureDecision,
} from "./failure-posture.ts";
export {
  applyModifications,
  ModificationsInvalidError,
  validateDecision,
  type ValidateDecisionContext,
  type ValidatedDecision,
} from "./validate-decision.ts";
