/** Public surface of the inspector package. */
export {
  tailEnvelopeLog,
  type EnvelopeLogDirection,
  type EnvelopeLogEntry,
  type TailEnvelopeLogOptions,
} from "./tail-envelope-log.ts";
export {
  outcomeMessageOf,
  renderDecisionBadge,
  renderEnvelopeLogEntry,
  renderOutcome,
  renderRpcError,
  type DecisionMessage,
  type OutcomeMessage,
  type PolicyReference,
  type RenderOptions,
  type RpcErrorMessage,
} from "./render.ts";
