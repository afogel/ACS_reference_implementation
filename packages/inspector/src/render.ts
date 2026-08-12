/**
 * U20 (envelope stream) and U21 (decision badge).
 *
 * Every function here is pure: no clock, no env, no process. The CLI decides
 * whether the terminal wants ANSI and passes `color`; tests assert exact
 * plain strings. Nothing here knows what produced a decision -- the badge
 * reads ACS's own `decision`, `reason_codes`, and `policy_references`
 * fields and nothing else (global constraint 9).
 *
 * `renderDecisionBadge` is TOLD a decision rather than handed a log row to
 * interrogate (PR #11 review). It used to take an `EnvelopeLogEntry` and dig
 * `entry.envelope.result.decision` out of it, which made "render this
 * decision" read as "ask this log line what it contains" and tied U21 to the
 * one artifact that happens to carry a decision today. The digging now lives
 * in `outcomeMessageOf`, one named translation from an S6 line to the small
 * message the renderers actually need; anything else able to build that
 * message can use them without owning an envelope log.
 *
 * A DECISION AND AN ERROR ARE TWO OUTCOMES, NOT TWO DECISIONS (PR #11 review,
 * second pass). The message used to be one type called `DecisionMessage` whose
 * second arm was a JSON-RPC error, and both arms went through
 * `renderDecisionBadge` -- so U21, the affordance whose whole job is making an
 * ACS decision legible, was also the thing that rendered responses carrying no
 * decision at all. The slices doc's own watch-for says the opposite in as many
 * words: a schema-invalid envelope "is answered with a JSON-RPC error", and
 * that is deliberately not a decision, because turning Guardian-side failures
 * into honoured ACS denies is N27 and belongs to a later slice. A type and a
 * function that said otherwise taught the reader the thing that slice exists to
 * correct.
 *
 * So the union is `OutcomeMessage`, discriminated, and each arm has its own
 * renderer: `renderDecisionBadge` (U21, decisions only) and `renderRpcError`
 * (a response that carried no decision). `renderOutcome` dispatches, and is
 * what the stream renderer calls.
 */
import type { EnvelopeLogEntry } from "./tail-envelope-log.ts";

export type RenderOptions = { color?: boolean; indent?: number };

const RESET = "\u001b[0m";
const RED = "\u001b[31m";
const GREEN = "\u001b[32m";
const YELLOW = "\u001b[33m";
const CYAN = "\u001b[36m";
const DIM = "\u001b[2m";

export type PolicyReference = { policy_id?: string; policy_version?: string; rule_id?: string };

/**
 * U21's message: what a caller tells the decision badge, already narrowed to
 * the ACS fields it renders. Only ever an actual ACS decision -- see
 * `OutcomeMessage` for why that is now the type's whole content.
 */
export type DecisionMessage = {
  decision: string;
  reason_codes: string[];
  policy_references: PolicyReference[];
};

/** What a response carried instead of a decision: the JSON-RPC error object. */
export type RpcErrorMessage = { code: number | null; message: string };

/**
 * What one S6 response line reports about its step: a decision, or the
 * JSON-RPC error that stood in place of one.
 *
 * A discriminated union rather than one object with an optional `error` beside
 * a `decision`, because a response carries exactly one of them and the other
 * arm's fields would have to be invented. A `steps/*` response either names an
 * ACS `decision` or is a JSON-RPC error; a caller cannot report both, and
 * cannot report neither.
 *
 * `kind` rather than structural narrowing on a key's presence, so the two arms
 * stay tellable apart by a caller that does not already know which fields
 * belong to which -- and so the union reads as two outcomes rather than as a
 * decision with an error mode.
 */
export type OutcomeMessage =
  | ({ kind: "decision" } & DecisionMessage)
  | ({ kind: "error" } & RpcErrorMessage);

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

/** The `policy_references` a response carried, narrowed to objects. Kept
 * separate from the formatting below so the message stays structured: a
 * caller building a `DecisionMessage` by hand passes references, not
 * pre-rendered strings. */
function policyReferenceList(value: unknown): PolicyReference[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is PolicyReference => typeof item === "object" && item !== null);
}

/** Formats each `policy_references` entry as `policy_id#rule_id`, falling
 * back to the bare `policy_id` when `rule_id` is absent. ACS's schemas do
 * not require `rule_id` on a policy_reference, so that fallback is a real
 * shape this renders deliberately, not a defect. */
function formatReferences(references: PolicyReference[]): string[] {
  return references.map((ref) => (ref.rule_id ? `${ref.policy_id ?? "?"}#${ref.rule_id}` : `${ref.policy_id ?? "?"}`));
}

/**
 * What one S6 line reports, or null when it reports no outcome at all: a
 * request, or a response such as a ServerHello.
 *
 * The one place in this module that reads an envelope's shape. It is a
 * translation, not a collaboration -- it turns an artifact into the message the
 * renderers speak -- and confining it here is what lets `renderDecisionBadge`
 * be told a decision instead of interrogating a log row for one.
 */
export function outcomeMessageOf(entry: EnvelopeLogEntry): OutcomeMessage | null {
  if (entry.direction !== "response") {
    return null;
  }
  const envelope = (typeof entry.envelope === "object" && entry.envelope !== null ? entry.envelope : {}) as ResponseEnvelope;

  if (envelope.error) {
    return {
      kind: "error",
      code: typeof envelope.error.code === "number" ? envelope.error.code : null,
      message: typeof envelope.error.message === "string" ? envelope.error.message : "",
    };
  }

  const result = envelope.result;
  if (!result || typeof result.decision !== "string") {
    return null;
  }

  return {
    kind: "decision",
    decision: result.decision,
    reason_codes: stringList(result.reason_codes),
    policy_references: policyReferenceList(result.policy_references),
  };
}

/**
 * A response that carried no decision, rendered as the error it was.
 *
 * Its own function rather than an arm of the decision badge (PR #11 review,
 * second pass): what it renders is the absence of a decision, and in this slice
 * that is exactly the boundary the runbook and the slices doc both draw --
 * a schema-invalid envelope comes back as a JSON-RPC error, and N27, which
 * turns Guardian-side failures into honoured ACS denies, is a later slice. The
 * line looks like the badge beside it on purpose; what changed is that no type
 * and no function calls it a decision any more.
 */
export function renderRpcError(message: RpcErrorMessage, options: RenderOptions = {}): string {
  const color = options.color ?? false;
  const code = message.code ?? "?";
  const text = message.message;
  return paint(`✖ ERROR ${code}${text ? `  ${text}` : ""}`, RED, color);
}

/** U21. Renders the ACS decision it is given. */
export function renderDecisionBadge(message: DecisionMessage, options: RenderOptions = {}): string {
  const color = options.color ?? false;

  const reasonCodes = message.reason_codes;
  const references = formatReferences(message.policy_references);

  let head: string;
  if (message.decision === "deny") {
    head = paint("● DENY", RED, color);
  } else if (message.decision === "allow" && references.length > 0) {
    // A policy fired and the action still proceeded. ACS carries that as
    // `allow` with a non-empty `policy_references`, and rendering it
    // identically to a clean allow is exactly what this badge exists to
    // prevent (slices doc, section V2).
    //
    // The label used to name the policy runtime's own word for this case,
    // which ACS does not have -- the comment above it said so in the same
    // breath. R5.2 exists so this package carries no policy-runtime
    // vocabulary at all, and a string on screen teaches it more effectively
    // than an identifier would. What is left is what ACS itself says
    // happened (PR #11 review).
    head = paint("◐ ALLOW (policy fired)", YELLOW, color);
  } else if (message.decision === "allow") {
    head = paint("○ ALLOW", GREEN, color);
  } else {
    head = paint(`◆ ${message.decision.toUpperCase()}`, CYAN, color);
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

/** The line one S6 outcome renders as -- U21's badge for a decision, the error
 * line for a response that carried none. One dispatch, so the stream renderer
 * does not have to know the arms apart. */
export function renderOutcome(message: OutcomeMessage, options: RenderOptions = {}): string {
  return message.kind === "decision" ? renderDecisionBadge(message, options) : renderRpcError(message, options);
}

/**
 * U20. Header line, optional badge line, then the envelope as pretty JSON.
 *
 * What the body shows is the JSON value S6 recorded, printed unmodified:
 * nothing here strips a field, redacts a value, or reorders anything. It is
 * not a byte-for-byte replay of the wire, and this comment used to say it
 * was (whole-branch review, finding 2). The Guardian records `await req.json()`,
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
  const message = outcomeMessageOf(entry);
  const outcome = message === null ? null : renderOutcome(message, options);
  // `JSON.stringify` returns `undefined` -- not a string -- for an entry
  // whose `envelope` key is absent, and `join` would coerce that to an empty
  // line indistinguishable from a real blank body. `isEnvelopeLogEntryShape`
  // does not require `envelope` (it is `unknown` by design), so a hand-written
  // or truncated S6 line reaches here without one. Narrowed the way the badge
  // path above narrows (whole-branch review, finding 8).
  const body = JSON.stringify(entry.envelope, null, options.indent ?? 2) ?? "(no envelope recorded)";

  return [header, ...(outcome === null ? [] : [outcome]), body].join("\n");
}
