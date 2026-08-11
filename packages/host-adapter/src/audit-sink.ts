/**
 * S14 -- the host-side audit sink. §6.4 makes one thing a MUST: every step
 * that proceeds without a decision is recorded, so a fail-open bypass is
 * visible rather than silent. That is the entire job.
 *
 * TOTAL BY CONSTRUCTION (Global Constraint 2, inherited from N26's envelope
 * tap). This sink runs on the decision path, in a hook process whose stdout
 * is a policy decision. It must never throw, never change a decision, and
 * never delay one beyond the append it is asked for -- so the first failure
 * disables it, reports once, and every later write is a no-op.
 *
 * It does, however, SAY whether the append happened: `write` returns a
 * boolean. Totality and silence are different properties, and only the first
 * one is Global Constraint 2's. Constraint 3 -- "a proceed with no audit
 * entry is a silent bypass and is the one outcome this slice exists to make
 * impossible" -- is the one that governs when the two collide, because §6.4
 * makes the entry a MUST for a step that proceeds without a decision: an
 * unauditable bypass is not a bypass the spec permits. So the sink still
 * never throws, and `applyFailurePosture` (N6) decides what an unrecorded
 * proceed means. This sink does not decide it, and does not change a
 * decision to express it.
 *
 * Structurally the same as packages/guardian/src/envelope-tap.ts, and
 * deliberately not shared with it: that one is the Guardian's (P3, the
 * wire), this one is the host's (P1, the posture). They record different
 * things at different sides of the wire, and R3.2 keeps the host adapter
 * free of the Guardian's imports.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEntry = {
  /**
   * 1-based and per *session*: continued from the entries already in the log
   * when this sink first writes to it, not counted from zero per instance.
   * The shipped host runs each hook in a fresh subprocess with a fresh sink,
   * so a per-instance counter made every entry in a session `seq: 1` --
   * ordering nothing, unable to exhibit the gap the rest of this sentence
   * tells a reader to look for, and rendering as three identical `#1`
   * headers that read as one entry repeated. Gaps mean lost writes.
   */
  seq: number;
  recorded_at: string;
  session_id: string;
  /**
   * The ACS method whose decision failed to arrive, or `null` when the
   * failure happened before a request could be built and so no ACS method
   * was ever determined. It is never a host's own hook or event name: this
   * field is read by consumers that know ACS and nothing else (the Inspector
   * renders it verbatim), and a host name arriving here would make an
   * ACS-only reader print one.
   */
  method: string | null;
  rpc_id: string | number | null;
  /** The posture in force -- negotiated, or the ACS default when nothing was. */
  posture: "proceed" | "deny";
  /** Whether `posture` was negotiated at handshake or is the ACS default
   * because no handshake ever completed. The `reasoning` string a human
   * reads in a transcript is ephemeral; this field carries the same
   * distinction into the durable record, because "the guardian was down
   * for this whole session" and "this deployment chose to fail open" are
   * different incidents and the audit log is where that has to survive. */
  posture_source: "negotiated" | "default";
  /**
   * What became of the step. `proceeded` is the fail-open bypass §6.4 requires
   * be recorded.
   *
   * A THIRD vocabulary beside the wire posture (`proceed|deny`) and the ACS
   * decision (`allow|deny`), and kept as one on purpose -- the review asks for a
   * third stem only if the Inspector's badge genuinely needs it (PR #12,
   * Important), and it does. Two things it buys, both visible on one rendered
   * line of `bun run inspector`:
   *
   *   - `renderAuditEntry` prints the outcome and `posture=` side by side.
   *     Mirroring the posture would print one word twice and lose which of the
   *     two a reader is looking at: what this deployment declared, against what
   *     became of this step.
   *   - Mirroring the ACS decision would badge the line `ALLOW`/`DENY`, which
   *     is the envelope stream's vocabulary for a step whose decision genuinely
   *     arrived. Every line in THIS log is a step where none did, and that
   *     difference is the entire thing §6.4 requires be visible.
   *
   * Past tense for the same reason: this field reports, it does not declare.
   * Derived from the posture in exactly one place (failure-posture.ts's
   * RESOLUTION_BY_POSTURE), so the two can never disagree about a step.
   */
  outcome: "proceeded" | "blocked";
  failure: { kind: string; message: string };
  /**
   * Present only when establishing this session's negotiated config failed
   * -- a handshake that never completed, or a ServerHello that could not be
   * stored. Separate from `failure`, which is always the failure of the step
   * this entry is filed against: the two are different requests that fail
   * for unrelated reasons, and merging them would misattribute one to the
   * other. Recorded because a session whose config cannot be *persisted*
   * re-handshakes on every hook and silently never applies the posture the
   * deployment declared -- which is how a deployment that asked to fail
   * closed ends up failing open, and `posture_source: "default"` alone says
   * that happened without saying why.
   */
  session_failure?: { kind: string; message: string };
};

export type AuditEvent = Omit<AuditEntry, "seq" | "recorded_at">;

export type AuditSink = {
  /** Where entries land, or null for the null sink. */
  path: string | null;
  /**
   * Appends one entry. Never throws (Global Constraint 2). Returns true when
   * the entry was actually recorded and false otherwise, so a caller that
   * must not proceed unrecorded (constraint 3, §6.4) can tell the difference.
   * A false return has already been reported through `onError`; the caller
   * does not need to report it again.
   */
  write(event: AuditEvent): boolean;
};

/**
 * Used where no audit path is configured. Accepts writes, records nothing --
 * and says so, by returning false: "nothing was recorded" is exactly what a
 * caller weighing constraint 3 needs to hear, and claiming otherwise would
 * make this the one sink that can hide a bypass.
 */
export const NULL_AUDIT_SINK: AuditSink = {
  path: null,
  write(): boolean {
    return false;
  },
};

export type CreateAuditSinkOptions = {
  path: string;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

/**
 * The highest sequence number already in the log, so a fresh sink continues
 * the session rather than restarting it (see AuditEntry.seq). Falls back to
 * the line count when a line carries no usable `seq`, so an unparseable
 * entry still consumes its number instead of being overwritten in spirit by
 * the next one.
 *
 * TOTAL, like everything else here: a missing or unreadable log means "start
 * from 1", never a throw. Losing the ability to continue the numbering must
 * not cost the entry itself, which is the thing §6.4 actually requires.
 */
function highestSeqIn(path: string): number {
  try {
    const lines = readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    let highest = 0;
    for (const line of lines) {
      try {
        const { seq } = JSON.parse(line) as { seq?: unknown };
        if (typeof seq === "number" && Number.isFinite(seq) && seq > highest) {
          highest = seq;
        }
      } catch {
        // Counted by `lines.length` below; nothing else to do with it.
      }
    }
    return Math.max(highest, lines.length);
  } catch {
    return 0;
  }
}

export function createAuditSink({ path, now = () => new Date(), onError }: CreateAuditSinkOptions): AuditSink {
  // Undefined until the first write reads the log. Deferred deliberately:
  // most hook invocations never write an audit entry at all (nothing failed
  // to be delivered), and reading the log at construction would put an fs
  // read on the decision path of every one of them.
  let seq: number | undefined;
  let disabled = false;

  function fail(error: unknown): void {
    // Set FIRST: if onError throws, this sink must already be disabled, or a
    // second write would call the throwing reporter again.
    disabled = true;
    if (onError) {
      try {
        onError(error);
      } catch {
        // A broken reporter cannot be reported. Nothing further to do.
      }
      return;
    }
    try {
      console.error(`audit sink disabled: ${error instanceof Error ? error.message : String(error)}`);
    } catch {
      // stderr is unavailable; there is nowhere left to say so.
    }
  }

  return {
    path,
    write(event: AuditEvent): boolean {
      if (disabled) {
        return false;
      }
      try {
        if (seq === undefined) {
          seq = highestSeqIn(path);
        }
        const entry: AuditEntry = { seq: seq + 1, recorded_at: now().toISOString(), ...event };
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
        // Only after a successful append, so a failed write does not consume
        // a sequence number and invent a gap that never happened.
        seq += 1;
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
  };
}
