/**
 * The ACS decision message this adapter speaks. Kept in a module of its own so
 * every module that touches one -- render-decision.ts (which renders one),
 * guardian-client.ts (which receives one off the wire), and whatever later
 * slices add between them -- speaks the same message rather than each
 * declaring its own shape of it.
 *
 * Deliberately not an import of the Guardian's own `AcsDecision`. The Guardian
 * declares the same message (packages/guardian/src/map-verdict.ts) as a strict
 * union of the five ACS dispositions, because it is the side that *builds*
 * one. This side reads one off HTTP, so it is deliberately loose: only
 * `decision` is required, and everything else a caller touches is named by the
 * hookmap rather than assumed to exist under a fixed key. The Guardian's type
 * is assignable to this one; the two share the NAME rather than an import,
 * because this package must not depend on the Guardian's type graph.
 *
 * One noun for "the ACS decision for this step", across both sides of the
 * seam. Any later refinement should stay an adjective containing this stem
 * (`ValidatedAcsDecision`), never a parallel noun.
 *
 * ACS's decision vocabulary, nothing else.
 */

/**
 * The ACS decision for one step, as this adapter reads it. Loose on purpose --
 * see the module header: only `decision` is required.
 */
export type AcsDecision = { decision: string } & Record<string, unknown>;
