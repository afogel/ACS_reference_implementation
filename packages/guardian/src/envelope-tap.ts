/**
 * writeEnvelopeTap (N26) writes S6: a JSONL record of every ACS envelope
 * that crosses this Guardian's wire, in both directions, exactly as it
 * crossed (global constraint 11). The Envelope Inspector (P4) reads this
 * file and nothing else -- see packages/inspector, which deliberately
 * imports nothing from here.
 *
 * Total by construction (global constraint 8). Every write is wrapped: a
 * failure disables the tap for the process lifetime, reports once, and is
 * never propagated to the caller. The tap sits on the decision path, and
 * V1 shipped three separate fail-opens before they were caught -- an
 * observability feature that can turn a governed tool call into an
 * ungoverned one would be the fourth. Observability degrades; governance
 * does not.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type TapDirection = "request" | "response";

/**
 * One line of S6. `envelope` is the JSON-RPC object verbatim -- request or
 * response -- and every other field is Guardian-side context the wire does
 * not carry: a sequence number so a reader can detect gaps, a timestamp, the
 * direction, the ACS method (JSON-RPC responses carry none, so the Guardian
 * supplies the one it dispatched), and the JSON-RPC id that pairs the two
 * directions.
 */
export type TapEntry = {
  seq: number;
  recorded_at: string;
  direction: TapDirection;
  method: string | null;
  rpc_id: string | number | null;
  envelope: unknown;
};

export type EnvelopeTap = {
  write(direction: TapDirection, envelope: unknown, method: string | null): void;
  readonly path: string | null;
};

export type CreateEnvelopeTapOptions = {
  path: string;
  /** Injectable clock, so tests can assert recorded_at exactly. */
  now?: () => Date;
  /** Called at most once, on the first failure. Defaults to one stderr line. */
  onError?: (error: unknown) => void;
};

/** The tap a Guardian gets when no envelopeLogPath was configured (P3). */
export const NULL_TAP: EnvelopeTap = {
  path: null,
  write(): void {},
};

/** The JSON-RPC id, when it is a scalar. Both request and response envelopes
 * carry `id` at the top level, so one extractor serves both directions. */
export function extractRpcId(envelope: unknown): string | number | null {
  if (typeof envelope === "object" && envelope !== null && "id" in envelope) {
    const id = (envelope as { id: unknown }).id;
    if (typeof id === "string" || typeof id === "number") {
      return id;
    }
  }
  return null;
}

export function createEnvelopeTap({ path, now = () => new Date(), onError }: CreateEnvelopeTapOptions): EnvelopeTap {
  let seq = 0;
  let disabled = false;

  const fail = (error: unknown): void => {
    disabled = true;
    try {
      if (onError) {
        onError(error);
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`envelope tap disabled after failure (${path}): ${message}`);
    } catch {
      // Silently swallow any error from the callback or console.error
      // to maintain the total-by-construction guarantee
    }
  };

  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (error) {
    fail(error);
  }

  return {
    path,
    write(direction, envelope, method): void {
      if (disabled) {
        return;
      }
      try {
        const entry: TapEntry = {
          seq: seq + 1,
          recorded_at: now().toISOString(),
          direction,
          method,
          rpc_id: extractRpcId(envelope),
          envelope,
        };
        const line = `${JSON.stringify(entry)}\n`;
        appendFileSync(path, line);
        seq += 1;
      } catch (error) {
        fail(error);
      }
    },
  };
}
