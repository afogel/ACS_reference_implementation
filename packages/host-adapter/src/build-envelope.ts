/**
 * buildEnvelope turns a host's own hook invocation into an ACS v0.1.0 request
 * envelope (a `steps/*` method), driven entirely by a hookmap -- never by
 * host-specific literals baked into this function.
 *
 * This package knows ACS and hookmaps, nothing else. No file under
 * packages/host-adapter/ may name a policy runtime, its rule language, or its
 * decision vocabulary, and a grep gate in the test suite checks that. This
 * module has no runtime dependency on the Guardian package or the policy
 * bridge behind it: it talks to the Guardian over the wire, never in-process.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * A hookmap value the host sent no field for: the constant this hook always
 * means. `{ literal: success }` on a hook a host fires only for the successful
 * case says that in data, rather than a path being invented to derive it from a
 * neighbouring field the host never meant that way.
 */
export type HookmapLiteral = { literal: string };

/** Where a result-gate hook's output lives in the raw hook payload. */
export type HookmapOutputs = {
  /** JSONPath-lite (`$.foo.bar`) to the leaf that becomes `outputs[0].value`. */
  from: string;
  /**
   * JSONPath-lite (`$.foo.bar`) to the object that leaf sits inside. Declared
   * here and read by the render side, not by this module: a decision replacing
   * the output is applied into a clone of that object, so every sibling field
   * the host put beside the leaf survives the round trip. A replacement missing
   * one of them is a shape the host may decline, and a declined replacement
   * delivers the original -- which is why the whole object is named, not just
   * the leaf that goes on the wire.
   */
  within: string;
};

/** The two members every hook entry carries, whichever payload it builds. */
type HookmapHookEntryCommon = {
  /** The ACS `steps/*` method this hook fires. Never hardcoded here. */
  acs_method: string;
  /** JSONPath-lite (`$.foo.bar`) into the raw hook payload for the tool/step name. */
  tool_name: string;
};

/** A hook asking before a step runs: builds a tool-call-request payload. */
export type HookmapRequestHookEntry = HookmapHookEntryCommon & {
  /** JSONPath-lite (`$.foo.bar`) into the raw hook payload for the argument bag. */
  arguments: string;
  outputs?: never;
  exit_status?: never;
};

/** A hook asking after a step ran: builds a tool-call-result payload. */
export type HookmapResultHookEntry = HookmapHookEntryCommon & {
  arguments?: never;
  outputs: HookmapOutputs;
  /** The exit status this hook means -- see HookmapLiteral for why a literal. */
  exit_status: HookmapLiteral;
};

/**
 * One hook's mapping onto an ACS method: S1's `hooks.<hookName>` entry.
 *
 * Exactly one of `arguments` and `outputs`, spelled as an exclusive union --
 * each member declaring the other's keys as `?: never` -- rather than as one
 * type with both keys optional. The optional-key form types the two broken
 * entries as legal: one declaring both names two payload shapes at once, one
 * declaring neither names none, and both would only be complained about at the
 * far end, as a rejected envelope, by which point the fault reads as a policy
 * failure rather than as the hookmap typo it is. `buildEnvelope` makes the same
 * check at runtime, where a hookmap parsed out of YAML actually lands.
 */
export type HookmapHookEntry = HookmapRequestHookEntry | HookmapResultHookEntry;

/**
 * A hookmap in full: the hook-name -> ACS method mapping this module consumes,
 * plus the decision -> host-output mapping renderDecision consumes. The second
 * is on the type only so that a hookmap loaded whole, as `loadHookmap` does,
 * round-trips without losing it.
 */
export type Hookmap = {
  host: string;
  hooks: Record<string, HookmapHookEntry>;
  decisions?: Record<string, unknown>;
};

/** An ACS argument wrapper: every hook argument is `{value, provenance?}`. */
type AcsArgument = { value: unknown };

/** An ACS output wrapper: every step output is `{value, provenance?}` too. */
type AcsOutput = { value: unknown };

/** hooks/tool-call-request.json's payload: what a step was asked to do. */
export type AcsToolCallRequestPayload = {
  tool: { name: string };
  arguments: Record<string, AcsArgument>;
  exit_status?: never;
  outputs?: never;
};

/**
 * hooks/tool-call-result.json's payload: what a step produced. That schema
 * requires exactly `tool`, `exit_status` and `outputs` -- a different member set
 * from the request payload, not the request payload plus extras.
 */
export type AcsToolCallResultPayload = {
  tool: { name: string };
  arguments?: never;
  exit_status: string;
  outputs: AcsOutput[];
};

/**
 * The payload an envelope carries, as an exclusive union of the two shapes --
 * for the same reason `HookmapHookEntry` is one. A single type with every member
 * optional would let a caller build an envelope carrying neither shape, and the
 * type would have said nothing: a payload that names no step is then rejected at
 * the far end, where the rejection reads as governance declining a step rather
 * than as this module having built nothing coherent to govern.
 */
export type AcsRequestPayload = AcsToolCallRequestPayload | AcsToolCallResultPayload;

/** The ACS v0.1.0 request envelope this module produces. */
export type AcsRequestEnvelope = {
  jsonrpc: "2.0";
  method: string;
  id: string;
  params: {
    acs_version: string;
    request_id: string;
    timestamp: string;
    metadata: {
      agent_id: string;
      session_id: string;
    };
    payload: AcsRequestPayload;
  };
};

const ACS_VERSION = "0.1.0";

/**
 * A hookmap's `decisions` block must declare at least `allow` and `deny`
 * -- the only two decisions a delivery-failure posture
 * (applyFailurePosture) ever produces -- and every entry it DOES
 * declare must actually be renderable, not merely present. "Renderable"
 * means shaped like render-decision.ts's own `DecisionRenderRule`: a
 * non-null object naming a non-empty string `permissionDecision`, the one
 * field renderDecision writes into Claude Code's output unconditionally.
 * Presence alone is not enough to guarantee that: `allow: null` still
 * satisfies `"allow" in decisions`, and then renderDecision throws on the
 * non-object entry; `allow: {}` also satisfies it and renderDecision does
 * NOT throw, but writes `permissionDecision: undefined`, which
 * `JSON.stringify` then drops entirely -- stdout ends up with no decision
 * in it at all, defeating "always a decision on stdout" exactly as surely
 * as a missing entry does, just more quietly.
 *
 * Every declared entry is checked here, not only `allow` and `deny`: a
 * malformed `modify` (or `ask`, or `defer`) entry would otherwise only
 * surface when a Guardian actually returns that decision, and by then the
 * throw lands inside the shim's own catch, gets treated as a delivery
 * failure, and the posture answers it as a fail-open proceed -- an
 * arriving policy decision silently degraded into the exact bypass this
 * project exists to remove. Checking every entry at load time closes that
 * before it can happen, for the cost of one loop.
 *
 * What this actually guarantees, once it passes: every entry `loadHookmap`
 * accepted is renderable. That is what lets a caller's own fallback render
 * of `applyFailurePosture`'s "allow"/"deny" output be trusted never to
 * throw -- not because `allow` and `deny` merely exist, but because
 * existing here means shape-checked here.
 *
 * What "shape-checked" means is the hookmap's own declarative output shape:
 * an entry carries a non-empty `output` block, and every
 * field in it names either a literal `value` or a non-empty `from`. It is
 * deliberately not a check for any particular host field -- this module names
 * none, and test/invariants.test.ts gates that -- so the check is that the
 * rule is renderable, not that it renders anything in particular.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRenderableDecisions(hookmap: Hookmap, path: string): void {
  const decisions = hookmap.decisions;
  if (typeof decisions !== "object" || decisions === null) {
    throw new Error(`loadHookmap: ${path} has no "decisions" block`);
  }
  for (const required of ["allow", "deny"] as const) {
    if (!(required in decisions)) {
      throw new Error(`loadHookmap: ${path}'s "decisions" block has no "${required}" entry`);
    }
  }
  for (const [decision, rule] of Object.entries(decisions)) {
    if (!isPlainObject(rule)) {
      throw new Error(
        `loadHookmap: ${path}'s "decisions.${decision}" entry must be an object carrying an "output" block, got ${JSON.stringify(rule)}`,
      );
    }
    const output = rule.output;
    if (!isPlainObject(output) || Object.keys(output).length === 0) {
      throw new Error(
        `loadHookmap: ${path}'s "decisions.${decision}" entry needs a non-empty "output" block, got ${JSON.stringify(output)}`,
      );
    }
    // The same rule renderDecision enforces per field, checked here so that
    // "loadHookmap accepted it" and "renderDecision can render it" cannot come
    // apart. A field naming neither source is a hookmap typo; the decision it
    // belongs to would render an output missing a field its author believes is
    // there, and for `modify` or `ask` that is a policy decision arriving and
    // being silently degraded.
    for (const [field, source] of Object.entries(output)) {
      if (!isPlainObject(source)) {
        throw new Error(
          `loadHookmap: ${path}'s "decisions.${decision}" output field "${field}" must be an object naming ` +
            `"value" or "from", got ${JSON.stringify(source)}`,
        );
      }
      const hasValue = Object.prototype.hasOwnProperty.call(source, "value");
      const hasFrom = typeof source.from === "string" && source.from.length > 0;
      if (!hasValue && !hasFrom) {
        throw new Error(
          `loadHookmap: ${path}'s "decisions.${decision}" output field "${field}" must name a literal "value" ` +
            `or a non-empty string "from", got ${JSON.stringify(source)}`,
        );
      }
    }
  }
}

/** Loads and parses a hookmap YAML file (e.g. claude-code.hookmap.yaml).
 * Throws if `decisions` is missing `allow` or `deny`, or if any declared
 * entry is not a renderable rule -- see assertRenderableDecisions. */
export function loadHookmap(path: string): Hookmap {
  const hookmap = Bun.YAML.parse(readFileSync(path, "utf8")) as Hookmap;
  assertRenderableDecisions(hookmap, path);
  return hookmap;
}

/**
 * Unwraps ACS's `{value, provenance?}` argument shape back into a plain
 * `{argName: value}` bag -- the same values `buildEnvelope` just put on the
 * wire. Knowledge of the ACS argument wrapper belongs here, next to the
 * type that defines it, not duplicated in every host shim that needs the
 * unwrapped form (e.g. to hand a `modify` decision's `parameter_overrides`
 * something to apply against, per N7's `validateDecision`).
 *
 * A result payload has no arguments to unwrap -- `arguments` is a member of the
 * request payload alone -- so it unwraps to the empty bag. That is a fact about
 * the payload shape, not a failure: throwing here would hand a caller an
 * exception for an envelope it built correctly, and a caller answering
 * exceptions with a failure posture would then resolve a perfectly good step by
 * posture instead of by the decision it was about to go and ask for.
 */
export function unwrapArguments(envelope: AcsRequestEnvelope): Record<string, unknown> {
  const { payload } = envelope.params;
  if (payload.arguments === undefined) {
    return {};
  }
  const originalArguments: Record<string, unknown> = {};
  for (const [key, argument] of Object.entries(payload.arguments)) {
    originalArguments[key] = argument.value;
  }
  return originalArguments;
}

/**
 * Resolves a JSONPath-lite reference (`$.foo.bar`, or `$` alone) against a
 * raw hook payload. Only dotted field access is supported: every hookmap path
 * is a single top-level field, and nothing here needs array indexing or filters.
 */
function resolvePath(payload: Record<string, unknown>, path: string): unknown {
  const segments = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current: unknown = payload;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * The payload half of an envelope, built from whichever of the two shapes the
 * hookmap entry declares.
 *
 * Branches on the entry's SHAPE, never on `acs_method`. The method is a string a
 * hookmap author types; branching on it would make a typo in it silently select
 * a payload shape, and the shape that actually matters is the one the entry's
 * own paths can build. `acs_method` stays what it has always been here: carried
 * onto the envelope verbatim, never read.
 *
 * An entry declaring both keys, or neither, names no single payload shape and
 * throws with the hook named. There is deliberately no default and no partial
 * payload: falling back to one shape would put a payload on the wire the hook's
 * own paths were never written to fill, and the far end would then be governing
 * a step it had been described wrongly, rather than the hookmap being reported
 * broken here where it can be fixed.
 */
function buildPayload(
  event: string,
  payload: Record<string, unknown>,
  entry: HookmapHookEntry,
  toolName: string,
): AcsRequestPayload {
  // `?? undefined` because a hookmap is YAML: a key written with nothing after
  // it parses to null, which is a key present and unusable, not a key absent.
  const argumentsPath = entry.arguments ?? undefined;
  const outputs = entry.outputs ?? undefined;

  if (argumentsPath !== undefined && outputs !== undefined) {
    throw new Error(
      `buildEnvelope: hookmap entry for hook "${event}" declares both "arguments" and "outputs" -- ` +
        `an entry names exactly one payload shape`,
    );
  }

  if (argumentsPath !== undefined) {
    const rawArguments = resolvePath(payload, argumentsPath);
    const args: Record<string, AcsArgument> = {};
    if (rawArguments !== null && typeof rawArguments === "object") {
      for (const [key, value] of Object.entries(rawArguments as Record<string, unknown>)) {
        args[key] = { value };
      }
    }
    return { tool: { name: toolName }, arguments: args };
  }

  if (outputs !== undefined) {
    // The entry's own three members are checked first and the payload after. A
    // malformed entry is a hookmap fault and an unresolvable path is a payload
    // fault; which of these throws is what tells an incident reviewer apart,
    // and validating the entry as a whole first stops a broken entry being
    // reported as a payload that was missing something.
    const from = isPlainObject(outputs) && typeof outputs.from === "string" ? outputs.from : "";
    if (from.length === 0) {
      throw new Error(
        `buildEnvelope: hookmap entry for hook "${event}" declares "outputs" without a non-empty "outputs.from" path`,
      );
    }

    // `within` is validated here even though this module never reads it, for
    // exactly the reason assertRenderableDecisions validates a decision entry it
    // never renders: so that "buildEnvelope accepted this entry" and "the render
    // side can apply a replacement through it" cannot come apart. An entry
    // naming `from` and no `within` builds a clean envelope and a correct
    // decision comes back, and the gap surfaces only at render -- where a
    // replacement carrying the named leaf ALONE is a shape a host may decline,
    // and a declined replacement means the original output is delivered. A
    // redaction that does not land is a failure, not a partial success, so an
    // entry missing `within` is malformed and says so here, where a hookmap
    // author can still fix it, rather than at the one moment it matters.
    const within = isPlainObject(outputs) && typeof outputs.within === "string" ? outputs.within : "";
    if (within.length === 0) {
      throw new Error(
        `buildEnvelope: hookmap entry for hook "${event}" declares "outputs" without a non-empty ` +
          `"outputs.within" path -- a replacement applied to the named leaf alone loses every sibling ` +
          `field beside it, and a replacement a host declines delivers the original`,
      );
    }

    const exitStatus = isPlainObject(entry.exit_status) ? entry.exit_status.literal : undefined;
    if (typeof exitStatus !== "string" || exitStatus.length === 0) {
      throw new Error(
        `buildEnvelope: hookmap entry for hook "${event}" declares "outputs" without a non-empty ` +
          `"exit_status.literal"`,
      );
    }

    const value = resolvePath(payload, from);
    if (value === undefined) {
      throw new Error(
        `buildEnvelope: hookmap path "${from}" for hook "${event}" did not resolve -- a result payload ` +
          `carrying no output would ask the far end to govern a step whose output it cannot see`,
      );
    }

    return { tool: { name: toolName }, exit_status: exitStatus, outputs: [{ value }] };
  }

  throw new Error(
    `buildEnvelope: hookmap entry for hook "${event}" declares neither "arguments" nor "outputs" -- ` +
      `an entry names exactly one payload shape`,
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fixed, arbitrary namespace UUID used only to derive a stable v5 UUID from
// a host session id that is not itself a UUID -- Claude Code's session_id
// is host-assigned free-form text with no uuid guarantee, but ACS's
// metadata.session_id schema field requires format "uuid". Never
// regenerate this constant: doing so changes every derived session_id.
const SESSION_ID_NAMESPACE = "11c79ebd-8469-4b4e-8de0-72674add484c";

/**
 * Maps a host's raw session id onto a schema-valid uuid. If the host
 * already hands us a uuid, it is carried through unchanged (lowercased).
 * Otherwise a RFC 4122 version-5 (namespace + SHA-1) uuid is derived
 * deterministically -- the same raw session id always derives the same
 * uuid, so per-session correlation on the Guardian side survives the
 * translation honestly, rather than a random uuid being minted and
 * silently discarding the host's real session identity.
 */
export function toSessionUuid(rawSessionId: string): string {
  if (UUID_RE.test(rawSessionId)) {
    return rawSessionId.toLowerCase();
  }

  const namespaceBytes = Buffer.from(SESSION_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(Buffer.concat([namespaceBytes, Buffer.from(rawSessionId, "utf8")]))
    .digest();

  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant

  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Builds an ACS v0.1.0 request envelope from a raw hook invocation.
 * `hookmap` drives every host-shape decision: the ACS method, which of the two
 * payload shapes this hook carries, and where the tool/step name and that
 * shape's own content live in the raw payload. An event name absent from
 * `hookmap.hooks` throws, and so does an entry naming no single payload shape --
 * there is no default method, no default shape, and no partial envelope.
 */
export function buildEnvelope(event: string, payload: Record<string, unknown>, hookmap: Hookmap): AcsRequestEnvelope {
  const entry = hookmap.hooks[event];
  if (!entry) {
    throw new Error(`buildEnvelope: hookmap has no entry for hook "${event}"`);
  }

  const toolName = resolvePath(payload, entry.tool_name);
  if (typeof toolName !== "string") {
    throw new Error(
      `buildEnvelope: hookmap path "${entry.tool_name}" for hook "${event}" did not resolve to a string`,
    );
  }

  const acsPayload = buildPayload(event, payload, entry, toolName);

  const rawSessionId = payload.session_id;
  if (typeof rawSessionId !== "string" || rawSessionId.length === 0) {
    throw new Error(`buildEnvelope: hook payload for "${event}" is missing a "session_id" string field`);
  }

  const requestId = randomUUID();

  return {
    jsonrpc: "2.0",
    method: entry.acs_method,
    id: requestId,
    params: {
      acs_version: ACS_VERSION,
      request_id: requestId,
      timestamp: new Date().toISOString(),
      metadata: {
        agent_id: hookmap.host,
        session_id: toSessionUuid(rawSessionId),
      },
      payload: acsPayload,
    },
  };
}
