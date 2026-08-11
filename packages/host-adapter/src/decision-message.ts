/**
 * The ACS decision message this adapter speaks. Kept in a module of its own so
 * every module that touches one -- render-decision.ts (which renders one),
 * guardian-client.ts (which receives one off the wire), and whatever later
 * slices add between them -- speaks the same message rather than each
 * declaring its own shape of it.
 *
 * ONE STEM (PR #10 review, Important and its naming-symmetry companion). There
 * is one public noun for "the ACS decision for this step". The Guardian
 * produced `AcsDecision` and this side consumed `AcsDecisionResult`, so a
 * reader following one decision across the seam learned a second name for a
 * role that had not changed -- `Result` describes a processing stage, not a
 * different message. Any later refinement of it should stay an adjective that
 * still contains this stem (`ValidatedAcsDecision`), never a parallel noun.
 *
 * WHY THIS IS NOT AN IMPORT OF THE GUARDIAN'S OWN `AcsDecision`. The Guardian
 * declares the same message (packages/guardian/src/map-verdict.ts) as a strict
 * union of the five ACS dispositions, because it is the side that *builds*
 * one. This side reads one off HTTP, so it is deliberately loose: only
 * `decision` is required, and everything else a caller touches is named by the
 * hookmap rather than assumed to exist under a fixed key. The two are
 * structurally compatible in the direction that matters (the Guardian's is
 * assignable to this one), and they share the NAME rather than an import,
 * because R3.2 forbids this package depending on the Guardian's type graph.
 *
 * R3.2: ACS's decision vocabulary, nothing else.
 */

/**
 * The ACS decision for one step, as this adapter reads it. Loose on purpose --
 * see the module header: only `decision` is required.
 */
export type AcsDecision = { decision: string } & Record<string, unknown>;
