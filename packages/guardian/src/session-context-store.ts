/**
 * The store a session's chain, intent, and provenance record live in, and
 * the verbs that read and write it.
 *
 * `loadSessionContext` and `appendContextEntry` are a matched pair: the
 * reader and the writer of one chain.
 *
 * Three roles, split on one axis: does the Guardian's request path send this
 * message? `SessionContextStore` is what `evaluateStep` uses and therefore
 * what a stand-in for it has to answer -- every member of it is sent on a
 * real step. The other two carry what nothing on that path sends yet.
 * `SessionIntentStore` carries the session's intent, whose ACS wire `intent`
 * object is unread, so its only senders are tests.
 * `SessionProvenanceReader` carries the whole provenance record, of which
 * the request path reads the labels and nothing else. Leaving those
 * on the live role would make every stand-in answer questions production
 * never asks, which is a documented affordance dressed up as a collaborator.
 * The memory store implements all three, so nothing here is deleted or
 * hidden; it is only off the interface the Guardian depends on until a
 * request-path caller for it exists.
 *
 * Every read is one record wide. There is deliberately no reader returning a
 * whole `SessionState`: handing over the aggregate is as wide a surface on
 * the way out as handing over a whole record to edit and write back would be
 * on the way in, and the aggregate is the memory store's own business rather
 * than a message anyone is sent. On the write side the same rule holds and
 * is stronger --
 * `replaceIfcLabels` is told an array, so it changes labels and cannot
 * express changing `origin` or `source_id`, and `ifc-labels.ts` cannot reach
 * fields it has no business touching.
 *
 * `appendLine` is how the Inspector's session-context view sees the chain
 * without importing this package: the Guardian hands the store a line
 * appender, and the Inspector tails the file it writes and re-declares the
 * entry type itself, so nothing about that view depends on the Guardian's
 * internals.
 */
import {
  GENESIS_HASH,
  emptySessionState,
  hashEntry,
  type IfcLabels,
  type Intent,
  type SessionContext,
  type SessionContextEntry,
  type SessionProvenance,
  type SessionState,
  type SessionStep,
} from "./session-context.ts";

export {
  GENESIS_HASH,
  type IfcLabels,
  type Intent,
  type SessionContext,
  type SessionContextEntry,
  type SessionProvenance,
  type SessionStep,
} from "./session-context.ts";

/** What the Guardian's request path is told and asks on every step. */
export interface SessionContextStore {
  context(sessionId: string): SessionContext;
  append(sessionId: string, step: SessionStep): SessionContextEntry;
  replaceIfcLabels(sessionId: string, labels: IfcLabels): void;
  sourceLabels(sessionId: string): IfcLabels;
}

/**
 * The intent pair, kept off `SessionContextStore` until something on the
 * request path writes an intent. `createMemorySessionContextStore`
 * implements it.
 */
export interface SessionIntentStore {
  setIntent(sessionId: string, text: string): void;
  intent(sessionId: string): Intent | undefined;
}

/**
 * The whole provenance record. The request path asks only for the labels,
 * through
 * `SessionContextStore.sourceLabels`, so this reader is what keeps the rest
 * of the record observable -- specifically that `replaceIfcLabels` leaves
 * `provenance_id`, `origin` and `source_id` as session birth wrote them.
 * Without it that invariant would hold only by inspection.
 */
export interface SessionProvenanceReader {
  provenance(sessionId: string): SessionProvenance;
}

export type CreateMemorySessionContextStoreOptions = {
  now?: () => Date;
  /** Called once per appended entry with its JSON line, no trailing newline. */
  appendLine?: (line: string) => void;
};

/**
 * The in-memory store. Named for what it is rather than as the default one --
 * a bare `createSessionContextStore` would read as the general factory and
 * is not.
 */
export function createMemorySessionContextStore(
  options: CreateMemorySessionContextStoreOptions = {},
): SessionContextStore & SessionIntentStore & SessionProvenanceReader {
  const now = options.now ?? (() => new Date());
  const appendLine = options.appendLine;
  const sessions = new Map<string, SessionState>();

  /** A read: never creates a session, so asking about one is not writing one. */
  const read = (sessionId: string): SessionState => sessions.get(sessionId) ?? emptySessionState(sessionId);

  const ensure = (sessionId: string): SessionState => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = emptySessionState(sessionId);
    sessions.set(sessionId, fresh);
    return fresh;
  };

  return {
    context(sessionId) {
      return read(sessionId).context;
    },

    append(sessionId, step) {
      const state = ensure(sessionId);
      const previous = state.context.entries.at(-1);
      const withoutHash: Omit<SessionContextEntry, "hash"> = {
        session_id: sessionId,
        seq: (previous?.seq ?? 0) + 1,
        prev_hash: previous?.hash ?? GENESIS_HASH,
        recorded_at: now().toISOString(),
        method: step.method,
        request_id: step.request_id,
        tool_name: step.tool_name,
      };
      const entry: SessionContextEntry = { ...withoutHash, hash: hashEntry(withoutHash) };
      sessions.set(sessionId, {
        ...state,
        context: { ...state.context, entries: [...state.context.entries, entry] },
      });
      appendLine?.(JSON.stringify(entry));
      return entry;
    },

    setIntent(sessionId, text) {
      const state = ensure(sessionId);
      // Intent is an immutable baseline: the first one a session declares is
      // the one it is held to. Later ones are dropped rather than refused,
      // because a step arriving with a different intent is a fact about the
      // step, not a reason to stop governing it.
      if (state.intent !== undefined) return;
      sessions.set(sessionId, { ...state, intent: { text, recorded_at: now().toISOString() } });
    },

    intent(sessionId) {
      return read(sessionId).intent;
    },

    replaceIfcLabels(sessionId, labels) {
      const state = ensure(sessionId);
      // Copied on the way in: the caller's array is the caller's, and a
      // caller that keeps editing it after this call must not be editing the
      // stored provenance record. Every other member of that record is left
      // exactly as it was -- this verb changes labels and cannot change
      // `origin`.
      sessions.set(sessionId, {
        ...state,
        provenance: { ...state.provenance, ifc_labels: [...labels] },
      });
    },

    sourceLabels(sessionId) {
      // Copied on the way out for the mirror-image reason: the value goes
      // into a snapshot that crosses the bridge into the policy runtime, and
      // a caller holding this array could edit the stored record by editing
      // a snapshot. The return type forbids that; the copy survives a caller
      // who casts.
      return [...read(sessionId).provenance.ifc_labels];
    },

    provenance(sessionId) {
      // Copied like the labels are, and for the same reason: the array inside
      // this record is the stored one, and handing it out uncopied would let
      // a reader edit the stored record by editing what it was shown.
      const stored = read(sessionId).provenance;
      return { ...stored, ifc_labels: [...stored.ifc_labels] };
    },
  };
}

/** The chain's reader, paired with `appendContextEntry`. */
export function loadSessionContext(store: SessionContextStore, sessionId: string): SessionContext {
  return store.context(sessionId);
}

/** Appends one step to this session's hash chain. */
export function appendContextEntry(
  store: SessionContextStore,
  sessionId: string,
  step: SessionStep,
): SessionContextEntry {
  return store.append(sessionId, step);
}
