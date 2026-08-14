/**
 * THE ORDER OF THE ONE EXCHANGE BOTH GATES RUN (§V5 review round 3, Task 6).
 *
 * `"tool.execute.before"` and `"tool.execute.after"` used to carry a copy each
 * of the same seven moves; they are one function now (`runExchange`, acs-plugin.ts),
 * and the two hook methods are edges that name their event and assemble their
 * own payload. Merging them removed the risk that the two copies drift out of
 * step. It introduced a different one: a single later edit to `runExchange` now
 * reorders BOTH gates at once, silently, and every step of that order is there
 * for a measured reason.
 *
 * So this file pins the order itself, as behaviour, from OUTSIDE the plugin --
 * the same three faults asked at both gates, each one arranged so that only one
 * ordering can produce the observed answer:
 *
 *   - `assertUsableTool` FIRST, ahead of the `tools` check: asked with a
 *     malformed `tool` AND an unusable `sessionID` at once, so the message says
 *     which of the two checks ran first. `Array.prototype.includes` answers a
 *     silent `false` for a malformed needle, so a `tools` check that ran first
 *     would return cleanly instead -- the exact fail-open §V5 review, Task 5,
 *     fix round 2, Important 2 measured and closed.
 *   - `governsTool`'s early return BEFORE `assertUsableSessionId`: an
 *     out-of-scope tool with an unusable `sessionID`. A clean return proves the
 *     skip is ahead of the session validation (and, with the `fetch` spy, ahead
 *     of the handshake); a throw about `sessionID` would prove it is not.
 *   - `assertUsableSessionId` BEFORE `resolveSessionConfig`/`governStep`: a
 *     GOVERNED tool with the same unusable `sessionID`, which must throw
 *     without a single request going out. `buildEnvelope` throws on a missing
 *     `session_id` too, but that throw lands in `governStep`'s stage-"request"
 *     catch and is answered by the negotiated posture, where a `proceed` is an
 *     ungoverned step -- so "it throws eventually" is not what is being pinned
 *     here; "it throws before anything is asked" is.
 *
 * NO LIVE GUARDIAN, DELIBERATELY, and the `fetch` spy is why: every case below
 * is supposed to end before the first request. Standing one up would make the
 * suite slower and the assertion weaker -- a case that wrongly proceeded would
 * then get an answer rather than being caught not asking.
 *
 * Per-gate coverage of the individual faults already exists (request-gate.test.ts
 * and result-gate.test.ts each pin their own `tool`/`sessionID`/`tools`
 * behaviour). What is new here is the ORDER between them, asked identically at
 * both gates -- which is what a shared `runExchange` makes a single property rather
 * than two.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcsPlugin } from "../acs-plugin.ts";

// "bash" is the tool opencode.hookmap.yaml scopes BOTH gates to (`tools:
// [bash]`), and "read" is one of the real OpenCode tool names measured beside
// it that neither gate lists -- the same pair request-gate.test.ts and
// result-gate.test.ts use for their own skip tests.
const GOVERNED_TOOL = "bash";
const UNLISTED_TOOL = "read";

// Nothing below should reach the audit sink -- every case returns or throws
// before `governStep` is called -- but the redirect is unconditional, the same
// discipline the other two gate suites keep: an entry written to the
// developer's own `.acs/audit.jsonl` would carry raw tool arguments.
const SCRATCH_DIR = mkdtempSync(join(tmpdir(), "acs-gate-ordering-test-"));
const AUDIT_LOG = join(SCRATCH_DIR, "audit.jsonl");

beforeAll(() => {
  process.env.ACS_AUDIT_LOG = AUDIT_LOG;
});

// PER TEST, NOT PER FILE, so "no audit entry" is a claim about THIS case and
// not about whichever case ran before it. Measured while checking that the
// three assertions below actually catch a reordering: with the sessionID check
// moved past the handshake, the one case that then reaches `governStep` writes
// an entry -- and every LATER test's `existsSync` assertion failed too, on a
// path the reordering never touched. Four failures, two of them naming nothing
// about the defect. The claim is worth asserting; the coupling is not part of
// it (§V5 review round 3, Task 6, fix round 1, Minor 3).
beforeEach(() => {
  rmSync(AUDIT_LOG, { force: true });
});

afterAll(() => {
  delete process.env.ACS_AUDIT_LOG;
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
});

type Hooks = Awaited<ReturnType<typeof AcsPlugin>>;

/**
 * One gate, reduced to what differs between them: its event name, a live object
 * shaped the way OpenCode hands THAT gate one, and how the hook is called.
 * Everything the assertions below check is shared, which is the point.
 */
type Gate = {
  readonly hook: "tool.execute.before" | "tool.execute.after";
  readonly freshLive: () => Record<string, unknown>;
  readonly fire: (hooks: Hooks, tool: unknown, sessionID: string, live: Record<string, unknown>) => Promise<void>;
};

const GATES: readonly Gate[] = [
  {
    hook: "tool.execute.before",
    // The mutable `{args}` OpenCode hands the request gate -- the only place it
    // puts them at that gate.
    freshLive: () => ({ args: { command: "ls -la" } }),
    fire: (hooks, tool, sessionID, live) =>
      hooks["tool.execute.before"]!(
        { tool: tool as string, sessionID, callID: "c1" },
        live as unknown as { args: unknown },
      ),
  },
  {
    hook: "tool.execute.after",
    // The whole live `{title, output, metadata}` object, shaped as a real
    // `bash` result is (`metadata.exit`/`metadata.output`, measured on
    // OpenCode 1.18.15 -- opencode.hookmap.yaml's own table).
    freshLive: () => ({
      title: "ls -la",
      output: "a\nb\n",
      metadata: { output: "a\nb\n", exit: 0, truncated: false },
    }),
    fire: (hooks, tool, sessionID, live) =>
      hooks["tool.execute.after"]!(
        { tool: tool as string, sessionID, callID: "c1", args: { command: "ls -la" } },
        live as unknown as { title: string; output: string; metadata: unknown },
      ),
  },
];

for (const gate of GATES) {
  describe(`the shared exchange's order, at "${gate.hook}"`, () => {
    it("refuses a malformed `tool` first, ahead of the `tools` check AND of the sessionID check", async () => {
      const hooks = await AcsPlugin({} as never);
      const live = gate.freshLive();
      const untouched = gate.freshLive();

      const fetchSpy = spyOn(globalThis, "fetch");
      try {
        // Both faults at once. A `tools` check that ran first would read
        // `undefined` as "not in this gate's list" and return CLEANLY; a
        // sessionID check that ran first would name the session id.
        let thrown: unknown;
        try {
          await gate.fire(hooks, undefined, "", live);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("no usable tool name");
        expect((thrown as Error).message).not.toContain("no usable sessionID");
        // The event name is carried from the hook method through `runExchange` into
        // the message -- so a gate handing the shared function the wrong
        // literal is visible here too.
        expect((thrown as Error).message).toContain(`"${gate.hook}"`);

        expect(live).toEqual(untouched);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(existsSync(AUDIT_LOG)).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("returns for a tool this gate does not govern before validating the session or negotiating one", async () => {
      const hooks = await AcsPlugin({} as never);
      const live = gate.freshLive();
      const untouched = gate.freshLive();

      const fetchSpy = spyOn(globalThis, "fetch");
      try {
        // An unusable sessionID beside an out-of-scope tool: the clean return
        // is only possible if the `tools` skip runs BEFORE
        // `assertUsableSessionId`, which is what makes an ungoverned tool cost
        // no session validation and no handshake round trip.
        await expect(gate.fire(hooks, UNLISTED_TOOL, "", live)).resolves.toBeUndefined();

        expect(live).toEqual(untouched);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(existsSync(AUDIT_LOG)).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("refuses an unusable `sessionID` for a governed tool before any request goes out", async () => {
      const hooks = await AcsPlugin({} as never);
      const live = gate.freshLive();
      const untouched = gate.freshLive();

      const fetchSpy = spyOn(globalThis, "fetch");
      try {
        let thrown: unknown;
        try {
          await gate.fire(hooks, GOVERNED_TOOL, "", live);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toContain("no usable sessionID");
        expect((thrown as Error).message).toContain(`"${gate.hook}"`);

        // Not merely "it throws": nothing was asked. `resolveSessionConfig`'s
        // handshake is the first thing that would have gone over the wire, and
        // `governStep` would have answered `buildEnvelope`'s own throw with the
        // negotiated posture instead of refusing.
        expect(live).toEqual(untouched);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(existsSync(AUDIT_LOG)).toBe(false);
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
}
