import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditSink } from "host-adapter";
// Not a bare "inspector" specifier: that string is a Node/Bun built-in
// module name (`node:inspector`), which core-module resolution picks over
// any workspace package of the same name with no way for us to override it.
// test/envelope-tap-roundtrip.test.ts sidesteps the same collision for the
// same package by importing the specific submodule directly rather than
// through the barrel; this file does the same.
import { tailAuditLog } from "../packages/inspector/src/tail-audit-log.ts";

/**
 * The contract test that keeps two independent AuditEntry declarations
 * honest -- the same job test/envelope-tap-roundtrip.test.ts does for
 * TapEntry, and the reason the R5.2 import gate is meaningful rather than
 * merely inconvenient. The Inspector declares its own type BECAUSE it must
 * not import the adapter's; that duplication is only safe while something
 * fails when the two drift.
 *
 * This file is the only place in the tree that imports both sides.
 */
const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "acs-audit-rt-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    for (const entry of readdirSync(dir)) unlinkSync(join(dir, entry));
    rmdirSync(dir);
  }
});

describe("S14 write -> N51 read: every field survives", () => {
  for (const outcome of ["proceeded", "blocked"] as const) {
    it(`round-trips a ${outcome} entry`, async () => {
      const path = join(scratch(), "audit.jsonl");
      createAuditSink({ path, now: () => new Date("2026-08-10T12:00:00.000Z") }).write({
        session_id: "sess-1",
        method: "steps/toolCallRequest",
        rpc_id: outcome === "proceeded" ? "req-1" : 7,
        posture: outcome === "proceeded" ? "proceed" : "deny",
        posture_source: "negotiated",
        outcome,
        failure: { kind: "timeout", message: "no decision within 5000ms" },
      });

      const read = [];
      for await (const entry of tailAuditLog({ path, fromStart: true })) {
        read.push(entry);
        break;
      }

      // toEqual, not toMatchObject: an extra field on either side is drift,
      // and drift is exactly what this test exists to catch.
      expect(read[0]).toEqual({
        seq: 1,
        recorded_at: "2026-08-10T12:00:00.000Z",
        session_id: "sess-1",
        method: "steps/toolCallRequest",
        rpc_id: outcome === "proceeded" ? "req-1" : 7,
        posture: outcome === "proceeded" ? "proceed" : "deny",
        posture_source: "negotiated",
        outcome,
        failure: { kind: "timeout", message: "no decision within 5000ms" },
      });
    });
  }

  it("survives a null rpc_id, which an unpaired failure produces", async () => {
    const path = join(scratch(), "audit.jsonl");
    createAuditSink({ path }).write({
      session_id: "s",
      method: "steps/toolCallRequest",
      rpc_id: null,
      posture: "proceed",
      posture_source: "default",
      outcome: "proceeded",
      failure: { kind: "transport", message: "gone" },
    });
    for await (const entry of tailAuditLog({ path, fromStart: true })) {
      expect(entry.rpc_id).toBeNull();
      break;
    }
  });
});
