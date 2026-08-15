import { describe, expect, it } from "bun:test";
import {
  GENESIS_HASH,
  appendContextEntry,
  createMemorySessionContextStore,
  loadSessionContext,
} from "../src/session-context-store.ts";

const at = (iso: string) => () => new Date(iso);
const step = (n: number) => ({ method: "steps/toolCallRequest", request_id: `req-${n}`, tool_name: "Bash" });

describe("SessionContext — the hash chain (S3)", () => {
  it("starts a session at the genesis hash and seq 1", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const entry = appendContextEntry(store, "sess-a", step(1));
    expect(entry.seq).toBe(1);
    expect(entry.prev_hash).toBe(GENESIS_HASH);
    expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("chains each entry to the one before it, per session", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const first = appendContextEntry(store, "sess-a", step(1));
    const second = appendContextEntry(store, "sess-a", step(2));
    expect(second.seq).toBe(2);
    expect(second.prev_hash).toBe(first.hash);
    expect(second.hash).not.toBe(first.hash);
  });

  it("keeps two sessions on independent chains", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    appendContextEntry(store, "sess-a", step(1));
    const b = appendContextEntry(store, "sess-b", step(1));
    expect(b.seq).toBe(1);
    expect(b.prev_hash).toBe(GENESIS_HASH);
    expect(loadSessionContext(store, "sess-a").entries).toHaveLength(1);
  });

  it("gives two entries at the same position different hashes when only tool_name differs", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const honest = appendContextEntry(store, "sess-a", step(1));
    const other = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    const forged = appendContextEntry(other, "sess-a", { ...step(1), tool_name: "Write" });
    expect(forged.hash).not.toBe(honest.hash);
  });

  it("loads an unknown session as an empty chain rather than throwing", () => {
    const store = createMemorySessionContextStore();
    const context = loadSessionContext(store, "never-seen");
    expect(context.entries).toEqual([]);
    expect(context.intent).toBeUndefined();
    // The lattice floor, not `[]`: `emptySessionContext` seeds a fresh
    // session at `["public"]`, because AGT's own IFC gate denies a
    // zero-label flow outright.
    expect(context.provenance.ifc_labels).toEqual(["public"]);
  });

  it("replaces the provenance record put on it, ifc_labels and all", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    store.putProvenance("sess-a", {
      provenance_id: "acs:external:doc-1",
      origin: "tool_output",
      ifc_labels: ["pii", "confidential"],
    });
    const context = loadSessionContext(store, "sess-a");
    expect(context.provenance.provenance_id).toBe("acs:external:doc-1");
    expect(context.provenance.origin).toBe("tool_output");
    expect(context.provenance.ifc_labels).toEqual(["pii", "confidential"]);
  });
});

describe("Intent (S4) — immutable baseline per session", () => {
  it("records the first intent it is given", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    store.setIntent("sess-a", "ship the redaction slice");
    expect(loadSessionContext(store, "sess-a").intent?.text).toBe("ship the redaction slice");
  });

  it("ignores every later intent, because the baseline is immutable", () => {
    const store = createMemorySessionContextStore({ now: at("2026-08-14T00:00:00.000Z") });
    store.setIntent("sess-a", "the baseline");
    store.setIntent("sess-a", "something else entirely");
    expect(loadSessionContext(store, "sess-a").intent?.text).toBe("the baseline");
  });
});

describe("the JSONL appender the Inspector tails", () => {
  it("emits one line per entry, in chain order", () => {
    const lines: string[] = [];
    const store = createMemorySessionContextStore({
      now: at("2026-08-14T00:00:00.000Z"),
      appendLine: (line) => lines.push(line),
    });
    appendContextEntry(store, "sess-a", step(1));
    appendContextEntry(store, "sess-a", step(2));
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as { seq: number; prev_hash: string; hash: string });
    expect(parsed.map((p) => p.seq)).toEqual([1, 2]);
    expect(parsed[1]!.prev_hash).toBe(parsed[0]!.hash);
  });
});
