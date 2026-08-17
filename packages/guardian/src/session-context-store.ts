/**
 * The store a session's chain, intent, and provenance record live in, and
 * the verbs that read and write it.
 *
 * `loadSessionContext` and `appendContextEntry` are a matched pair: the
 * reader and the writer of one chain. `loadSessionContext` returns exactly a
 * `SessionContext`; `load` returns the whole `SessionState` the store holds,
 * which is a wider thing with a wider name.
 *
 * The store is told, not asked, about labels: the session's provenance
 * record is reachable only through `replaceIfcLabels` and `sourceLabels`, so
 * no caller has to load a session, spread its provenance record, and write
 * the whole thing back just to change one member. A verb that returned the
 * whole record for a caller to edit and replace would let that caller change
 * `origin` or `source_id` while meaning only to set labels, and would let the
 * code in `ifc-labels.ts` reach into fields it has no business touching.
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
  type SessionContext,
  type SessionContextEntry,
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
  type SessionState,
  type SessionStep,
} from "./session-context.ts";

export interface SessionContextStore {
  load(sessionId: string): SessionState;
  append(sessionId: string, step: SessionStep): SessionContextEntry;
  setIntent(sessionId: string, text: string): void;
  replaceIfcLabels(sessionId: string, labels: IfcLabels): void;
  sourceLabels(sessionId: string): IfcLabels;
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
): SessionContextStore {
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
    load(sessionId) {
      return read(sessionId);
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
  };
}

/** The chain's reader, paired with `appendContextEntry`: returns the chain alone, not the whole session aggregate. */
export function loadSessionContext(store: SessionContextStore, sessionId: string): SessionContext {
  return store.load(sessionId).context;
}

/** Appends one step to this session's hash chain. */
export function appendContextEntry(
  store: SessionContextStore,
  sessionId: string,
  step: SessionStep,
): SessionContextEntry {
  return store.append(sessionId, step);
}
