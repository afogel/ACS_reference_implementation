/**
 * S14 -- the host-side audit sink. §6.4 makes one thing a MUST: every step
 * that proceeds without a decision is recorded, so a fail-open bypass is
 * visible rather than silent. That is the entire job.
 *
 * TOTAL BY CONSTRUCTION (Global Constraint 2, inherited from N26's envelope
 * tap). This sink runs on the decision path, in a hook process whose stdout
 * is a policy decision. It must never throw, never change a decision, and
 * never delay one beyond the append it is asked for. A sink that cannot
 * write degrades observability and nothing else -- so the first failure
 * disables it, reports once, and every later write is a no-op.
 *
 * Structurally the same as packages/guardian/src/envelope-tap.ts, and
 * deliberately not shared with it: that one is the Guardian's (P3, the
 * wire), this one is the host's (P1, the posture). They record different
 * things at different sides of the wire, and R3.2 keeps the host adapter
 * free of the Guardian's imports.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AuditEntry = {
  /** 1-based, per sink instance. Gaps mean lost writes. */
  seq: number;
  recorded_at: string;
  session_id: string;
  /** The ACS method whose decision failed to arrive. */
  method: string;
  rpc_id: string | number | null;
  /** The posture in force -- negotiated, or the ACS default when nothing was. */
  posture: "proceed" | "deny";
  /** `proceeded` is the fail-open bypass §6.4 requires be recorded. */
  outcome: "proceeded" | "blocked";
  failure: { kind: string; message: string };
};

export type AuditEvent = Omit<AuditEntry, "seq" | "recorded_at">;

export type AuditSink = {
  /** Where entries land, or null for the null sink. */
  path: string | null;
  write(event: AuditEvent): void;
};

/** Used where no audit path is configured. Accepts writes, records nothing. */
export const NULL_AUDIT_SINK: AuditSink = { path: null, write(): void {} };

export type CreateAuditSinkOptions = {
  path: string;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

export function createAuditSink({ path, now = () => new Date(), onError }: CreateAuditSinkOptions): AuditSink {
  let seq = 0;
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
    write(event: AuditEvent): void {
      if (disabled) {
        return;
      }
      try {
        const entry: AuditEntry = { seq: seq + 1, recorded_at: now().toISOString(), ...event };
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify(entry)}\n`);
        // Only after a successful append, so a failed write does not consume
        // a sequence number and invent a gap that never happened.
        seq += 1;
      } catch (error) {
        fail(error);
      }
    },
  };
}
