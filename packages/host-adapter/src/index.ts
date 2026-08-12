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
  modificationDocumentOf,
  toSessionUuid,
  type Hookmap,
  type HookmapHookEntry,
  type HookmapOutputs,
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
// The ACS decision message every seam below speaks, and the one refinement of
// it a host reads directly. One stem, adjectives for stage: the third member,
// `FailureResolvedAcsDecision`, is exported with the posture that produces it.
export { type AcsDecision, type ValidatedAcsDecision } from "./decision-message.ts";
export {
  governStep,
  type DecisionStage,
  type GovernStepInput,
  type GovernedStep,
} from "./govern-step.ts";
export {
  negotiateSessionConfig,
  resolveSessionConfig,
  ServerHelloInvalidError,
  SessionConfigNotStoredError,
  SessionConfigStoreFailedError,
  type HandshakeOptions,
  type ResolvedSessionConfig,
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
  // `AuditSink.write()` takes one of these, so a caller that builds an event
  // to hand to a sink could not name its type through this barrel. Coherent
  // under structural typing, which is why it went unnoticed -- but the barrel
  // is documented as "the whole contract a shim relies on", and a parameter
  // type of an exported method belongs in it.
  type AuditEvent,
  type AuditSink,
  type CreateAuditSinkOptions,
} from "./audit-sink.ts";
export {
  applyFailurePosture,
  classifyDeliveryFailure,
  classifySessionFailure,
  DEFAULT_POSTURE,
  DEFAULT_TIMEOUT_MS,
  type ApplyFailurePostureInput,
  type DeliveryFailureKind,
  type FailureResolvedAcsDecision,
  type FailureStage,
  type HostFailureKind,
  type SessionFailureKind,
  type StepFailureKind,
} from "./failure-posture.ts";
export { applyModifications, ModificationsInvalidError } from "./modifications.ts";
// The result gate's replacing output, and the target a caller has to name for
// one. `HostOutputLocation` is a member type of the exported
// `ValidateDecisionContext`, so a caller that builds a context could not name it
// through this barrel otherwise -- the same reason `AuditEvent` is above.
export {
  projectAppliedOutput,
  replacingOutput,
  withResultOutput,
  WITHHELD_OUTPUT,
  type HostOutputLocation,
} from "./result-output.ts";
export { validateDecision, type ValidateDecisionContext } from "./validate-decision.ts";
