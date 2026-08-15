/**
 * The store S3/S4/S5 live in, and the verbs that read and write it.
 *
 * `loadSessionContext` and `appendContextEntry` are a NAMED PAIR -- the
 * reader and the writer of one chain (slices/v6/README.md, commitment 4).
 * The retired `appendSessionEntry()` is not revived: set beside any
 * `SessionContext` reader it yields two different nouns for one store.
 * `loadSessionContext` returns exactly a `SessionContext`; `load` returns the
 * whole `SessionState` the store holds, which is a wider thing with a wider
 * name.
 *
 * THE STORE IS TOLD, NOT ASKED, ABOUT LABELS (PR #15 review). S5 is reachable
 * only through `replaceIfcLabels` and `sourceLabels` -- the field is named in
 * both, so no caller has to load a session, spread its provenance record and
 * write the whole thing back to change one member. The `putProvenance` that
 * used to be here let any caller replace `origin` and `source_id` while
 * meaning to set labels, and made N25 (`ifc-labels.ts`) reach into a record it
 * has no business reading.
 *
 * `appendLine` is how U22 sees the chain without importing this package
 * (R5.1). The Guardian hands the store a line appender; the Inspector tails
 * the file it writes and re-declares the entry type itself.
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
 * The in-memory store. Named for what it is rather than as the default one,
 * the same correction V5 made to `createMemorySessionConfigStore` -- a bare
 * `createSessionContextStore` would read as the general factory and is not.
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
      // S4 is an immutable baseline: the first intent a session declares is
      // the one it is held to. Later ones are dropped rather than refused,
      // because a step arriving with a different intent is a fact about the
      // step, not a reason to stop governing it.
      if (state.intent !== undefined) return;
      sessions.set(sessionId, { ...state, intent: { text, recorded_at: now().toISOString() } });
    },

    replaceIfcLabels(sessionId, labels) {
      const state = ensure(sessionId);
      // Copied on the way IN: the caller's array is the caller's, and a
      // caller that keeps editing it after this call must not be editing S5.
      // Every other member of the provenance record is left exactly as it
      // was -- this verb changes labels and cannot change `origin`.
      sessions.set(sessionId, {
        ...state,
        provenance: { ...state.provenance, ifc_labels: [...labels] },
      });
    },

    sourceLabels(sessionId) {
      // Copied on the way OUT for the mirror-image reason: the value goes into
      // a snapshot that crosses the bridge into the policy runtime, and a
      // caller holding this array could edit S5 by editing a snapshot. The
      // return type forbids that; the copy survives a caller who casts.
      return [...read(sessionId).provenance.ifc_labels];
    },
  };
}

/** S3's reader (commitment 4's twin of `appendContextEntry`): the chain, not the aggregate. */
export function loadSessionContext(store: SessionContextStore, sessionId: string): SessionContext {
  return store.load(sessionId).context;
}

/** N22: append one step to this session's hash chain. */
export function appendContextEntry(
  store: SessionContextStore,
  sessionId: string,
  step: SessionStep,
): SessionContextEntry {
  return store.append(sessionId, step);
}
