/**
 * N25 and its twin: the two halves of the round trip AGT's spec asks a host
 * to perform and declines to standardize.
 *
 * AGT's `verdict.schema.json` says the core "stores and propagates nothing"
 * and requires the host to persist returned labels and re-supply them. This
 * module is the Guardian doing exactly that job -- R8.1 made concrete. It is
 * not a criticism of AGT; it fills a role AGT explicitly delegates.
 *
 * NAMED FOR IFC, NOT FOR A GATE. The retired `persistResultLabels()` is not
 * revived: this Guardian has had a genuine result gate since V4
 * (`post_tool_call`), so "result labels" reads as that gate's labels rather
 * than as AGT's IFC tags (slices/v6/README.md, commitment 3).
 *
 * WHERE THE FIRST LABEL COMES FROM IS NOT HERE, and that is a property of
 * ACS v0.1.0 rather than of this module. AGT propagates labels it is given
 * and originates none -- `policy/lib/ifc.rego`'s `propagated_labels` returns
 * `[]` for an empty input rather than inventing one. And
 * `spec/acs/specification/v0.1.0/provenance.json` defines `provenance_id`,
 * `origin`, `source_id` and `derived_from`, and no member a sensitivity
 * label could be read from. So a session's first labels are
 * deployment-supplied, exactly as V3's drift score is and for the same
 * reason -- §V7 of the slices doc gives that score exactly this resolution:
 * green for the Guardian, red for a wire consumer. This slice's own
 * label-origin cell is not filed there yet.
 */
import type { IfcLabels, SessionContextStore } from "./session-context-store.ts";

/**
 * Persist what a verdict returned. `undefined` means the verdict carried no
 * `result_labels` member at all -- a policy that never ran the IFC gate --
 * and leaves what the session already had. An explicitly EMPTY array is a
 * different answer: the gate ran and propagated nothing, so the session's
 * labels are cleared. Conflating the two would make a session that once
 * touched secret data look secret forever.
 */
export function persistIfcLabels(
  store: SessionContextStore,
  sessionId: string,
  labels: IfcLabels | undefined,
): void {
  if (labels === undefined) return;
  const context = store.load(sessionId);
  store.putProvenance(sessionId, { ...context.provenance, ifc_labels: [...labels] });
}

/**
 * Read them back for the next snapshot. Returns a fresh array: the value
 * goes into a snapshot that crosses the bridge into the policy runtime, and
 * a caller holding the store's own array could edit S5 by editing a snapshot.
 */
export function supplySourceLabels(store: SessionContextStore, sessionId: string): string[] {
  return [...store.load(sessionId).provenance.ifc_labels];
}
