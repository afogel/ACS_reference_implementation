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
  type Hookmap,
  type HookmapHookEntry,
  type AcsRequestEnvelope,
} from "./build-envelope.ts";
export {
  createGuardianClient,
  GuardianResponseMismatchError,
  GuardianResultCorrelationError,
  type DecisionOrFailure,
  type GuardianClient,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
} from "./guardian-client.ts";
export { renderDecision, type HostOutput } from "./render-decision.ts";
export { type AcsDecision } from "./decision-message.ts";
export { negotiateSessionConfig, type HandshakeOptions } from "./handshake.ts";
export {
  createSessionConfigStore,
  isSessionConfig,
  type SessionConfig,
  type SessionConfigStore,
} from "./session-config.ts";
