/**
 * U20 (envelope stream) and U21 (decision badge).
 *
 * Both functions are pure: no clock, no env, no process. The CLI decides
 * whether the terminal wants ANSI and passes `color`; tests assert exact
 * plain strings. Nothing here knows what produced a decision -- the badge
 * reads ACS's own `decision`, `reason_codes`, and `policy_references`
 * fields and nothing else (global constraint 9).
 */
import type { EnvelopeLogEntry } from "./tail-envelope-log.ts";

export type RenderOptions = { color?: boolean; indent?: number };

const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const DIM = "\u001b[2m";

type PolicyReference = { policy_id?: string; policy_version?: string; rule_id?: string };
type DecisionResult = {
  decision?: unknown;
  reason_codes?: unknown;
  policy_references?: unknown;
};
type ResponseEnvelope = { result?: DecisionResult; error?: { code?: unknown; message?: unknown } };

function paint(text: string, color: string, enabled: boolean): string {
  return enabled ? `${color}${text}${RESET}` : text;
}

/** `2026-08-09T12:04:31.221Z` -> `12:04:31.221`. Sliced, not parsed: UTC and
 * locale-independent, so rendered output is the same everywhere. */
function clockOf(recordedAt: string): string {
  const time = recordedAt.slice(11, 23);
  return time.length === 12 ? time : recordedAt;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Formats each `policy_references` entry as `policy_id#rule_id`, falling
 * back to the bare `policy_id` when `rule_id` is absent. ACS's schemas do
 * not require `rule_id` on a policy_reference, so that fallback is a real
 * shape this renders deliberately, not a defect. */
function referenceList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is PolicyReference => typeof item === "object" && item !== null)
    .map((ref) => (ref.rule_id ? `${ref.policy_id ?? "?"}#${ref.rule_id}` : `${ref.policy_id ?? "?"}`));
}

/** U21. Null when this entry carries no decision and no error: a request, or
 * a response such as a ServerHello. */
export function renderDecisionBadge(entry: EnvelopeLogEntry, options: RenderOptions = {}): string | null {
  if (entry.direction !== "response") {
    return null;
  }
  const color = options.color ?? false;
  const envelope = (typeof entry.envelope === "object" && entry.envelope !== null ? entry.envelope : {}) as ResponseEnvelope;

  if (envelope.error) {
    const code = typeof envelope.error.code === "number" ? envelope.error.code : "?";
    const message = typeof envelope.error.message === "string" ? envelope.error.message : "";
    return paint(`✖ ERROR ${code}${message ? `  ${message}` : ""}`, RED, color);
  }

  const result = envelope.result;
  if (!result || typeof result.decision !== "string") {
    return null;
  }

  const reasonCodes = stringList(result.reason_codes);
  const references = referenceList(result.policy_references);

  let head: string;
  if (result.decision === "deny") {
    head = paint("● DENY", RED, color);
  } else if (result.decision === "allow" && references.length > 0) {
    // ACS has no `warn`; a policy that fired but let the action proceed
    // arrives as `allow` with a non-empty policy_references. Rendering it
    // identically to a clean allow is exactly what this badge exists to
    // prevent (slices doc, section V2).
    head = paint('◐ ALLOW (policy fired — ACS "warn")', YELLOW, color);
  } else if (result.decision === "allow") {
    head = paint("○ ALLOW", GREEN, color);
  } else {
    head = paint(`◆ ${result.decision.toUpperCase()}`, CYAN, color);
  }

  // Dimmed rather than left plain: with color:true, painting only `head`
  // made a coloured badge read as one coloured half and one plain half.
  // `paint` no-ops when `color` is false, so this changes nothing about the
  // color:false output the exact-string tests above assert byte-for-byte.
  const parts = [head];
  if (reasonCodes.length > 0) {
    parts.push(paint(`reason_codes=[${reasonCodes.join(", ")}]`, DIM, color));
  }
  if (references.length > 0) {
    parts.push(paint(`policy_references=[${references.join(", ")}]`, DIM, color));
  }
  return parts.join("  ");
}

/**
 * U20. Header line, optional badge line, then the envelope as pretty JSON.
 *
 * What the body shows is the JSON value S6 recorded, printed unmodified:
 * nothing here strips a field, redacts a value, or reorders anything. It is
 * not a byte-for-byte replay of the wire, and this comment used to say it
 * was (whole-branch review, finding 2). The Guardian taps `await req.json()`,
 * so the parse has already collapsed duplicate keys, canonicalised number
 * literals (`1.0` -> `1`), and hoisted integer-like object keys ahead of the
 * rest -- and tool argument names are host-controlled, so `arguments` really
 * can carry a key like `"0"`. Storing raw bytes instead would make
 * `entry.envelope` a string rather than a JSON value, which costs the
 * pretty-printing below and the round-trip contract test; an accurate
 * sentence is the better trade.
 */
export function renderEnvelopeLogEntry(entry: EnvelopeLogEntry, options: RenderOptions = {}): string {
  const color = options.color ?? false;
  const arrow = entry.direction === "request" ? "→ REQUEST " : "← RESPONSE";
  const method = entry.method ?? "(no method)";
  const id = entry.rpc_id === null ? "(unpaired)" : `id=${entry.rpc_id}`;

  const header = paint(`── #${entry.seq}  ${clockOf(entry.recorded_at)}  ${arrow}  ${method}  ${id}`, DIM, color);
  const badge = renderDecisionBadge(entry, options);
  // `JSON.stringify` returns `undefined` -- not a string -- for an entry
  // whose `envelope` key is absent, and `join` would coerce that to an empty
  // line indistinguishable from a real blank body. `isEnvelopeLogEntryShape`
  // does not require `envelope` (it is `unknown` by design), so a hand-written
  // or truncated S6 line reaches here without one. Narrowed the way the badge
  // path above narrows (whole-branch review, finding 8).
  const body = JSON.stringify(entry.envelope, null, options.indent ?? 2) ?? "(no envelope recorded)";

  return [header, ...(badge === null ? [] : [badge]), body].join("\n");
}
