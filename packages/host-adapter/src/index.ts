/**
 * Public surface of the host-adapter package (packages/host-adapter).
 *
 * Every host shim (N1 -- Task 9's Claude Code shim, and any later host from
 * slice V5) imports from here, not from individual src files, so this list
 * is the whole contract a shim relies on. R3.2 still binds every file this
 * barrel re-exports: no policy-runtime vocabulary of any kind anywhere
 * under packages/host-adapter/.
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
  type DecisionOrFailure,
  type GuardianClient,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcSuccessResponse,
  type JsonRpcErrorResponse,
} from "./guardian-client.ts";
export { renderDecision, type HostOutput } from "./render-decision.ts";
export { type AcsDecision } from "./decision-message.ts";
export { handshake, type HandshakeOptions } from "./handshake.ts";
export { createSessionConfigStore, type SessionConfig, type SessionConfigStore } from "./session-config.ts";
