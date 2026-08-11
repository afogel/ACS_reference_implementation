/**
 * createEnvelopeLogSink (N26) writes S6: a JSONL record of every ACS envelope
 * that crosses this Guardian's wire, in both directions. The Envelope
 * Inspector (P4) reads this file and nothing else -- see packages/inspector,
 * which deliberately imports nothing from here.
 *
 * Named for the artifact and the role, not for the mechanism (PR #11's naming
 * review). This used to be the `EnvelopeTap` / `createEnvelopeTap` /
 * `NULL_TAP` / `TapEntry` family: "tap the wire" is how the writer works, not
 * what a reader is looking at. V3 adds the host's audit rail as this rail's
 * sibling -- another total JSONL record of something that crossed a boundary,
 * which the Inspector will tail beside this one -- and two metaphors for one
 * job family would force every reader to translate between a "tap" and a
 * "sink". Naming this side for the log it produces is what makes the pair
 * read as a pair when the second rail lands.
 *
 * The affordance tables in docs/shaping/ label N26 `writeEnvelopeTap()`. No
 * such function has ever existed here -- the callable names are
 * `createEnvelopeLogSink` and the `write` method on the `EnvelopeLogSink` it
 * returns. The affordance ID is spelled out in this comment so a reader
 * hunting N26 from the slices doc lands here rather than on a name that
 * matches nothing.
 *
 * What "records the envelope" means here, precisely (global constraint 11,
 * as corrected by the whole-branch review's finding 2): the sink is handed
 * the JSON *value* the Guardian parsed, and writes it unmodified -- no field
 * stripping, no redaction, no reordering of anything we control. It is not a
 * byte-for-byte copy of the request body, and V2's documentation claimed it
 * was. The parse happens upstream in server.ts (`await req.json()`) and has
 * already collapsed duplicate keys, canonicalised number literals, and
 * hoisted integer-like object keys -- and `arguments` keys are
 * host-controlled, so `{"0": ...}` is a real shape, not a hypothetical.
 * Recording raw bytes instead would make `envelope` a string rather than a
 * JSON value, costing the Inspector its pretty-printing and the round-trip
 * contract test; the accurate sentence is the better trade.
 *
 * Total by construction (global constraint 8). Every write is wrapped: a
 * failure disables the sink for the process lifetime, reports once, and is
 * never propagated to the caller. The sink sits on the decision path, and
 * V1 shipped three separate fail-opens before they were caught -- an
 * observability feature that can turn a governed tool call into an
 * ungoverned one would be the fourth. Observability degrades; governance
 * does not.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Which side of the exchange one S6 line recorded. Named after the log, the
 * same way `EnvelopeLogEntry` is, so nothing on this rail carries the
 * writer's own nickname. */
export type EnvelopeLogDirection = "request" | "response";

/**
 * One line of S6, named for what was recorded rather than for what recorded
 * it. `envelope` is the JSON-RPC object as parsed, unmodified -- request or
 * response -- and every other field is Guardian-side context the wire does
 * not carry: a sequence number so a reader can detect gaps, a timestamp, the
 * direction, the ACS method (JSON-RPC responses carry none, so the Guardian
 * supplies the one it dispatched), and the JSON-RPC id that pairs the two
 * directions.
 */
export type EnvelopeLogEntry = {
  seq: number;
  recorded_at: string;
  direction: EnvelopeLogDirection;
  method: string | null;
  rpc_id: string | number | null;
  envelope: unknown;
};

/** Where S6 lines go: the Guardian-side writer role. */
export type EnvelopeLogSink = {
  write(direction: EnvelopeLogDirection, envelope: unknown, method: string | null): void;
  readonly path: string | null;
};

export type CreateEnvelopeLogSinkOptions = {
  path: string;
  /** Injectable clock, so tests can assert recorded_at exactly. */
  now?: () => Date;
  /** Called at most once, on the first failure. Defaults to one stderr line. */
  onError?: (error: unknown) => void;
};

/** The sink a Guardian gets when no envelopeLogPath was configured (P3).
 * Renamed in lockstep with the role it implements, so a composition root
 * disabling observability names the same rail the type does. */
export const NULL_ENVELOPE_LOG_SINK: EnvelopeLogSink = {
  path: null,
  write(): void {},
};

/** The JSON-RPC id, when it is a scalar. Both request and response envelopes
 * carry `id` at the top level, so one extractor serves both directions. */
export function extractRpcId(envelope: unknown): string | number | null {
  if (typeof envelope === "object" && envelope !== null && "id" in envelope) {
    const id = envelope.id;
    if (typeof id === "string" || typeof id === "number") {
      return id;
    }
  }
  return null;
}

export function createEnvelopeLogSink({
  path,
  now = () => new Date(),
  onError,
}: CreateEnvelopeLogSinkOptions): EnvelopeLogSink {
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
      console.error(`envelope log sink disabled after failure (${path}): ${message}`);
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
        const entry: EnvelopeLogEntry = {
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
