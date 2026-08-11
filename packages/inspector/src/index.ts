/** Public surface of the inspector package. */
export {
  tailEnvelopeLog,
  type EnvelopeLogDirection,
  type EnvelopeLogEntry,
  type TailEnvelopeLogOptions,
} from "./tail-envelope-log.ts";
export {
  decisionMessageOf,
  renderDecisionBadge,
  renderEnvelopeLogEntry,
  type DecisionMessage,
  type PolicyReference,
  type RenderOptions,
} from "./render.ts";
