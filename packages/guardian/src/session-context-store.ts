/**
 * The store S3/S4/S5 live in, and the two verbs that read and write it.
 *
 * `loadSessionContext` and `appendContextEntry` are a NAMED PAIR -- the
 * reader and the writer of one store (slices/v6/README.md, commitment 4).
 * The retired `appendSessionEntry()` is not revived: set beside any
 * `SessionContext` reader it yields two different nouns for one store.
 *
 * `appendLine` is how U22 sees the chain without importing this package
 * (R5.1). The Guardian hands the store a line appender; the Inspector tails
 * the file it writes and re-declares the entry type itself.
 */
import {
  GENESIS_HASH,
  emptySessionContext,
  hashEntry,
  type Provenance,
  type SessionContext,
  type SessionContextEntry,
  type SessionStep,
} from "./session-context.ts";

export {
  GENESIS_HASH,
  type IfcLabels,
  type Intent,
  type Provenance,
  type SessionContext,
  type SessionContextEntry,
  type SessionStep,
} from "./session-context.ts";

export interface SessionContextStore {
  load(sessionId: string): SessionContext;
  append(sessionId: string, step: SessionStep): SessionContextEntry;
  setIntent(sessionId: string, text: string): void;
  putProvenance(sessionId: string, provenance: Provenance): void;
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
  const sessions = new Map<string, SessionContext>();

  const ensure = (sessionId: string): SessionContext => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const fresh = emptySessionContext(sessionId);
    sessions.set(sessionId, fresh);
    return fresh;
  };

  return {
    load(sessionId) {
      return sessions.get(sessionId) ?? emptySessionContext(sessionId);
    },

    append(sessionId, step) {
      const context = ensure(sessionId);
      const previous = context.entries.at(-1);
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
      sessions.set(sessionId, { ...context, entries: [...context.entries, entry] });
      appendLine?.(JSON.stringify(entry));
      return entry;
    },

    setIntent(sessionId, text) {
      const context = ensure(sessionId);
      // S4 is an immutable baseline: the first intent a session declares is
      // the one it is held to. Later ones are dropped rather than refused,
      // because a step arriving with a different intent is a fact about the
      // step, not a reason to stop governing it.
      if (context.intent !== undefined) return;
      sessions.set(sessionId, { ...context, intent: { text, recorded_at: now().toISOString() } });
    },

    putProvenance(sessionId, provenance) {
      const context = ensure(sessionId);
      sessions.set(sessionId, { ...context, provenance });
    },
  };
}

/** S3's reader (commitment 4's twin of `appendContextEntry`). */
export function loadSessionContext(store: SessionContextStore, sessionId: string): SessionContext {
  return store.load(sessionId);
}

/** N22: append one step to this session's hash chain. */
export function appendContextEntry(
  store: SessionContextStore,
  sessionId: string,
  step: SessionStep,
): SessionContextEntry {
  return store.append(sessionId, step);
}
