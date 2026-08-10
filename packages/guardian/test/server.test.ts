import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { startGuardian } from "../src/index.ts";
import { toRepoRelativeMessage } from "../src/server.ts";

const HANDSHAKE_SCHEMA_PATH = "spec/acs/specification/v0.1.0/handshake.json";

/** Compiles the ServerHello $def straight out of the pinned handshake.json --
 * not a hand-copied shape -- so this test fails the moment our ServerHello
 * drifts from the schema, per the task's "read the schema yourself" note. */
function validateServerHello(candidate: unknown): void {
  const handshakeSchema = JSON.parse(readFileSync(HANDSHAKE_SCHEMA_PATH, "utf8")) as {
    $defs: { ServerHello: Record<string, unknown> };
  };
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(handshakeSchema.$defs.ServerHello);
  const valid = validate(candidate);
  if (!valid) {
    throw new Error(`ServerHello failed schema validation: ${JSON.stringify(validate.errors)}`);
  }
}

function makeEnvelope(
  method: string,
  payload: Record<string, unknown>,
  overrides: { id?: number; requestId?: string } = {},
): Record<string, unknown> {
  const { id = 1, requestId = crypto.randomUUID() } = overrides;
  return {
    jsonrpc: "2.0",
    method,
    id,
    params: {
      acs_version: "0.1.0",
      request_id: requestId,
      timestamp: new Date().toISOString(),
      metadata: { agent_id: "agent-1", session_id: crypto.randomUUID() },
      payload,
    },
  };
}

function toolCallEnvelope(command: string, overrides: { id?: number; requestId?: string } = {}) {
  return makeEnvelope(
    "steps/toolCallRequest",
    { tool: { name: "run_shell" }, arguments: { command: { value: command } } },
    overrides,
  );
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

async function postAcs(url: string, body: unknown): Promise<JsonRpcResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as JsonRpcResponse;
}

let url: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const guardian = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });
  url = guardian.url;
  close = guardian.close;
});

afterAll(async () => {
  await close();
});

describe("startGuardian POST /acs", () => {
  it("handshake/hello returns a schema-valid ServerHello with timeout_config.default_ms and on_decision_failure: proceed", async () => {
    const response = await postAcs(url, makeEnvelope("handshake/hello", {}, { id: 42 }));

    expect(response.error).toBeUndefined();
    expect(response.id).toBe(42);
    expect(response.result).toBeDefined();

    const serverHello = response.result as Record<string, unknown>;
    validateServerHello(serverHello);
    expect((serverHello.timeout_config as { default_ms: number }).default_ms).toBeGreaterThan(0);
    expect(serverHello.on_decision_failure).toBe("proceed");
  });

  it("steps/toolCallRequest carrying rm -rf / denies, with non-empty reasoning and reason_codes, echoing request_id", async () => {
    const requestId = crypto.randomUUID();
    const response = await postAcs(url, toolCallEnvelope("rm -rf /", { requestId }));

    expect(response.error).toBeUndefined();
    expect(response.result?.decision).toBe("deny");
    expect(response.result?.request_id).toBe(requestId);
    expect(typeof response.result?.reasoning).toBe("string");
    expect((response.result?.reasoning as string).length).toBeGreaterThan(0);
    expect(Array.isArray(response.result?.reason_codes)).toBe(true);
    expect((response.result?.reason_codes as unknown[]).length).toBeGreaterThan(0);
  });

  it("steps/toolCallRequest carrying ls -la allows, echoing request_id", async () => {
    const requestId = crypto.randomUUID();
    const response = await postAcs(url, toolCallEnvelope("ls -la", { requestId }));

    expect(response.error).toBeUndefined();
    expect(response.result?.decision).toBe("allow");
    expect(response.result?.request_id).toBe(requestId);
  });

  it("an unknown method returns a JSON-RPC error in the ACS-reserved -32000..-32099 range, not a decision", async () => {
    // Well-formed envelope (matches the method-prefix pattern, real ACS hook
    // name) but not one this Guardian dispatches -- distinct from a
    // malformed envelope, which fails schema validation instead.
    const response = await postAcs(url, makeEnvelope("steps/sessionStart", {}, { id: 7 }));

    expect(response.result).toBeUndefined();
    expect(response.id).toBe(7);
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
    expect(response.error?.code).toBeLessThanOrEqual(-32000);
  });

  // Scope boundary: a Guardian-side validation failure must surface as a bare
  // JSON-RPC error, never as an explicit ACS "deny" decision -- see
  // validate-envelope.test.ts's identical guard.
  it("an envelope that fails schema validation returns a JSON-RPC error in -32000..-32099, never a deny decision", async () => {
    const bad = toolCallEnvelope("rm -rf /");
    delete (bad.params as Record<string, unknown>).acs_version;

    const response = await postAcs(url, bad);

    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
    expect(response.error?.code).toBeLessThanOrEqual(-32000);
  });
});

// Fix wave finding 1 -- a real fail-open bug: an unhandled throw from
// assemblePreToolCallSnapshot/bridge.evaluate/mapVerdict inside handleAcsRequest used
// to escape uncaught, and Bun.serve's default error page for a rejected
// fetch() is `text/html`, not JSON. guardianClient.post's `res.json()` would
// then throw a SyntaxError instead of surfacing a JSON-RPC error, and
// acs-hook.ts's catch-all exits 1 with nothing on stdout -- Claude Code
// treats that as "the hook never fired" and the tool call proceeds
// ungoverned. This guards the fix, against a real (not mocked) AGT
// evaluation -- only mapping.yaml is swapped for a fixture that marks
// `allow` require_policy_references, so a genuine AGT "allow" verdict for a
// benign command (which carries no reason/message) makes mapVerdict throw
// inside handleAcsRequest for real.
describe("startGuardian POST /acs -- evaluation failure inside handleAcsRequest", () => {
  it("a real mapVerdict throw (require_policy_references unmet) still returns a parseable JSON-RPC error in -32000..-32099, not an HTML 500", async () => {
    const guardian = await startGuardian({
      port: 0,
      manifestPath: "policy/manifest.yaml",
      mappingPath: "packages/guardian/test/fixtures/mapping.require-policy-references-on-allow.yaml",
    });

    try {
      // res.json() below is exactly guardianClient.post's call. Before the
      // fix, Bun.serve's unhandled-rejection page is text/html and this
      // throws a SyntaxError instead of resolving -- the same failure mode
      // the finding describes at guardian-client.ts:70.
      const response = await postAcs(guardian.url, toolCallEnvelope("ls -la"));

      expect(response.result).toBeUndefined();
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
      expect(response.error?.code).toBeLessThanOrEqual(-32000);
      // Never a decision -- same scope boundary as the schema-validation
      // guard above.
      expect((response as Record<string, unknown>).decision).toBeUndefined();
    } finally {
      await guardian.close();
    }
  });
});

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const GUARDIAN_PKG = join(REPO_ROOT, "packages", "guardian");

/**
 * A stable, predictable name rather than an `mkdtempSync` random one
 * (backlog item C). This tree has to live *inside* `packages/guardian/` --
 * not under a repo-wide temp directory -- because it is a relative-path
 * trick: `validate-envelope.ts` resolves its schema root three directories
 * up from its own `import.meta.url`, so the copy has to sit at the same
 * depth under `packages/guardian/` for that resolution to land one level
 * short, on purpose (see the doc comment below). Bun's workspace module
 * resolution for the copy's own `import`s (`agt-bridge`, etc.) also
 * resolves relative to where the copy physically sits, which only works
 * predictably inside the real package tree.
 *
 * A fixed name means a killed run's leftover copy is not a fresh, unignored
 * directory tsc has never heard of: it is *this* directory, already covered
 * by `.gitignore` and by `tsconfig.json`'s `exclude`, so it cannot make
 * `bun run typecheck` see a stray duplicate of the Guardian's own source. A
 * run that starts while a previous killed run's copy is still here fails
 * loudly (`mkdirSync` on an existing directory throws) rather than quietly
 * reusing stale files -- the cure for that is deleting the leftover
 * directory by hand, not adding recovery logic that would have to guess
 * whether stale contents are safe to remove.
 */
const SCHEMALESS_SCRATCH_DIR = join(GUARDIAN_PKG, "tmp-schemaless-scratch");

/**
 * Runs `body` against a Guardian whose `validate-envelope.ts` cannot find the
 * ACS schemas -- the tree-cloned-without-`--recurse-submodules` case, which is
 * what makes the whole-branch review's finding 1 reachable rather than
 * theoretical.
 *
 * It is reproduced by *relocation*, not by mocking and not by touching
 * `spec/`. `validate-envelope.ts` derives SCHEMA_ROOT from its own
 * `import.meta.url` as `../../../spec/acs/specification/...`, so an identical
 * copy of `packages/guardian/src` placed one directory deeper resolves that
 * path to `packages/spec/acs/...`, which does not exist. Every line of
 * Guardian code that then runs is the real, current source -- the files are
 * copied at test time, so they cannot drift from `src/` -- and the failure it
 * produces is a real ENOENT out of `readdirSync`, thrown at request time
 * because `buildAjv()` is lazy. The first call to this function gets its own
 * module instance, so it cannot poison the Ajv registry the rest of this
 * suite shares. A later call importing the same fixed
 * `SCHEMALESS_SCRATCH_DIR` path a second time does not get a second fresh
 * instance -- Bun's module cache keys by resolved path, so it gets back the
 * *first* call's already-loaded module, and the freshly copied files on
 * disk for that later call go unread. Benign here (every call copies
 * byte-identical source, and this suite's own Ajv registry is never shared
 * with the copy either way), but worth being precise about now that the
 * directory name is fixed rather than fresh per call (backlog item C).
 *
 * Deletions here are explicit per file (repo constraint: nothing recursive).
 */
async function withSchemalessGuardian(
  body: (guardian: { url: string; logPath: string }) => Promise<void>,
): Promise<void> {
  const root = SCHEMALESS_SCRATCH_DIR;
  const srcDir = join(root, "src");
  const logPath = join(root, "envelopes.jsonl");
  const copied = readdirSync(join(GUARDIAN_PKG, "src")).filter((f) => f.endsWith(".ts"));
  let guardian: { close(): Promise<void> } | undefined;

  // Everything after this mkdirSync is inside the try: a failure while
  // copying, importing, or booting would otherwise leave a directory of
  // stray .ts files sitting inside packages/guardian.
  mkdirSync(root);
  try {
    mkdirSync(srcDir);
    for (const file of copied) {
      copyFileSync(join(GUARDIAN_PKG, "src", file), join(srcDir, file));
    }

    const relocated = (await import(join(srcDir, "index.ts"))) as typeof import("../src/index.ts");
    const started = await relocated.startGuardian({
      port: 0,
      manifestPath: join(REPO_ROOT, "policy", "manifest.yaml"),
      mappingPath: join(REPO_ROOT, "mapping.yaml"),
      envelopeLogPath: logPath,
    });
    guardian = started;

    await body({ url: started.url, logPath });
  } finally {
    await guardian?.close();
    for (const path of [logPath, ...copied.map((file) => join(srcDir, file))]) {
      try {
        unlinkSync(path);
      } catch {
        // a run that failed early never created every one of these
      }
    }
    for (const dir of [srcDir, root]) {
      try {
        rmdirSync(dir);
      } catch {
        // same
      }
    }
  }
}

/** Same reasoning as SCHEMALESS_SCRATCH_DIR: a stable, predictable name,
 * ignored and tsconfig-excluded, so a killed run cannot leave `bun run
 * typecheck` a stray copy of the Guardian's own source. A distinct name
 * from SCHEMALESS_SCRATCH_DIR, since a run of this suite can have both
 * scratch trees on disk at once. */
const NON_STRING_MESSAGE_SCRATCH_DIR = join(GUARDIAN_PKG, "tmp-nonstring-message-scratch");

/**
 * A test double, not the real `validate-envelope.ts`. It exists to force a
 * real `Error` whose `.message` has been overwritten to `undefined` through
 * `dispatch`'s one rethrow route -- the same route `withSchemalessGuardian`
 * above uses for a real ENOENT, but that route cannot also produce a
 * non-string `.message`: nothing in the real schema-validation path does
 * that to an error it throws. `EnvelopeValidationError` is redeclared here,
 * distinct from the real one, so `dispatch`'s
 * `error instanceof EnvelopeValidationError` check -- reading *this* file's
 * class, inside the relocated copy -- correctly comes back `false` and
 * rethrows, the same way it would for any error the real module didn't
 * throw as an `EnvelopeValidationError`.
 */
const NON_STRING_MESSAGE_VALIDATE_ENVELOPE_SOURCE = `
export class EnvelopeValidationError extends Error {}

export function validateEnvelope(_input) {
  const error = new Error("this message is about to be erased");
  error.message = undefined;
  throw error;
}
`;

/**
 * Runs \`body\` against a Guardian whose \`validate-envelope.ts\` has been
 * replaced by the test double above -- reproducing the blocking finding
 * from this wave's review: a real \`Error\`, thrown on \`dispatch\`'s one
 * rethrow route, whose \`.message\` is not a string. Structurally identical
 * to \`withSchemalessGuardian\`: a real, unmodified copy of every other file
 * in \`packages/guardian/src\`, dynamically imported from its own scratch
 * directory so it is a distinct module instance, with only
 * \`validate-envelope.ts\` swapped for the double. No \`envelopeLogPath\` --
 * this test needs no tap, and \`NULL_TAP\`'s totality is already covered
 * elsewhere.
 */
async function withNonStringMessageGuardian(body: (guardian: { url: string }) => Promise<void>): Promise<void> {
  const root = NON_STRING_MESSAGE_SCRATCH_DIR;
  const srcDir = join(root, "src");
  const copied = readdirSync(join(GUARDIAN_PKG, "src")).filter((f) => f.endsWith(".ts") && f !== "validate-envelope.ts");
  let guardian: { close(): Promise<void> } | undefined;

  mkdirSync(root);
  try {
    mkdirSync(srcDir);
    for (const file of copied) {
      copyFileSync(join(GUARDIAN_PKG, "src", file), join(srcDir, file));
    }
    writeFileSync(join(srcDir, "validate-envelope.ts"), NON_STRING_MESSAGE_VALIDATE_ENVELOPE_SOURCE);

    const relocated = (await import(join(srcDir, "index.ts"))) as typeof import("../src/index.ts");
    const started = await relocated.startGuardian({
      port: 0,
      manifestPath: join(REPO_ROOT, "policy", "manifest.yaml"),
      mappingPath: join(REPO_ROOT, "mapping.yaml"),
    });
    guardian = started;

    await body({ url: started.url });
  } finally {
    await guardian?.close();
    for (const path of [join(srcDir, "validate-envelope.ts"), ...copied.map((file) => join(srcDir, file))]) {
      try {
        unlinkSync(path);
      } catch {
        // a run that failed early never created every one of these
      }
    }
    for (const dir of [srcDir, root]) {
      try {
        rmdirSync(dir);
      } catch {
        // same
      }
    }
  }
}

// Whole-branch review, finding 1 -- the fourth fail-open of V1's shape, and
// the exit the tap's structural-totality claim did not cover. `dispatch`
// rethrows any non-EnvelopeValidationError, and nothing used to catch it:
// Bun.serve answers a rejecting fetch() handler with a `text/html` 500,
// guardian-client's unconditional `res.json()` throws `JSON Parse error:
// Unrecognized token '<'`, acs-hook.ts's catch-all exits 1 with empty stdout,
// and Claude Code reads that as "the hook didn't fire" -- the tool call
// proceeds ungoverned. S6 recorded the request and nothing else, so the
// Inspector could not even show that a response had been sent.
describe("startGuardian POST /acs -- the outer net around dispatch", () => {
  it("answers a throw from validateEnvelope itself with parseable JSON-RPC in -32000..-32099, never an HTML 500", async () => {
    await withSchemalessGuardian(async ({ url }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toolCallEnvelope("ls -la", { id: 5 })),
      });

      // Read as text first and parse by hand, so a regression reports the
      // HTML body it actually got instead of an opaque SyntaxError from
      // res.json() -- which is precisely what guardian-client would throw.
      const text = await res.text();
      expect(text.slice(0, 1)).toBe("{");
      const response = JSON.parse(text) as JsonRpcResponse;

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(5);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
      expect(response.error?.code).toBeLessThanOrEqual(-32000);
    });
  });

  // Backlog item B. The real ENOENT `withSchemalessGuardian` provokes names
  // this machine's absolute path in full (`readdirSync` on a schema
  // directory that does not exist at the relocated copy's resolved path):
  // before the fix, that absolute path -- this repo's own root, in
  // particular -- rode straight through to the client and into S6
  // unredacted. The fix strips only the repo-root prefix, so the
  // diagnostic remainder (the ENOENT text and the repo-relative path) is
  // still there for a real reader to use.
  it("strips this repo's absolute root out of a real error message before it reaches the client", async () => {
    await withSchemalessGuardian(async ({ url }) => {
      const response = await postAcs(url, toolCallEnvelope("ls -la"));

      expect(response.error).toBeDefined();
      const message = response.error?.message ?? "";
      expect(message).not.toContain(REPO_ROOT);
      expect(message).toContain("ENOENT");
      // The diagnostic remainder: which schema directory was missing,
      // relative rather than absolute. (Relative to the *relocated* copy's
      // own root, one level shallower than this file's REPO_ROOT above --
      // see withSchemalessGuardian's doc comment -- so no "packages/"
      // prefix here; that is this test harness's relocation depth, not a
      // second absolute-path leak.)
      expect(message).toContain("spec/acs/specification/v0.1.0");
    });
  });

  it("carries no decision -- N27 is V3, so a Guardian-side failure is an error, not a synthesized deny", async () => {
    await withSchemalessGuardian(async ({ url }) => {
      const response = await postAcs(url, toolCallEnvelope("rm -rf /"));

      expect(response.result).toBeUndefined();
      expect((response as Record<string, unknown>).decision).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain("deny");
    });
  });

  it("taps both the request and the response, so S6 has no untapped exit", async () => {
    await withSchemalessGuardian(async ({ url, logPath }) => {
      await postAcs(url, toolCallEnvelope("ls -la", { id: 11 }));

      const lines = readFileSync(logPath, "utf8").trim().split("\n");
      const entries = lines.map((line) => JSON.parse(line) as { direction: string; rpc_id: unknown });
      expect(entries.map((e) => e.direction)).toEqual(["request", "response"]);
      // Paired by JSON-RPC id (decision P4), which is what lets the Inspector
      // show the failure beside the request that caused it.
      expect(entries.map((e) => e.rpc_id)).toEqual([11, 11]);
    });
  });

  // Blocking finding from this wave's review. Pre-fix, toRepoRelativeMessage
  // assumed any `unknown` satisfying `error instanceof Error` also carried a
  // string `.message` -- true of the real ENOENT the test above forces, but
  // not something `instanceof Error` guarantees. An Error whose `.message`
  // has been overwritten to `undefined` throws `TypeError: undefined is not
  // an object (evaluating 'message.replace')` out of the helper itself --
  // and unlike the inner catch's own throw (contained by this outer catch),
  // a throw *from* the outer catch has nothing above `handleAcsRequest` to
  // catch it: Bun.serve's fetch handler has no try, so it answers with the
  // untapped HTML 500 the module header exists to prevent. Fails against
  // the pre-fix helper (confirmed by hand before implementing the fix: the
  // fetch below resolves to an HTML error page, and `res.json()` -- exactly
  // guardianClient.post's call -- throws a SyntaxError instead of returning
  // a response).
  it("does not let a real Error with a non-string .message escape the outer catch as an HTML 500", async () => {
    await withNonStringMessageGuardian(async ({ url }) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toolCallEnvelope("ls -la", { id: 9 })),
      });

      const text = await res.text();
      expect(text.slice(0, 1)).toBe("{");
      const response = JSON.parse(text) as JsonRpcResponse;

      expect(response.jsonrpc).toBe("2.0");
      expect(response.id).toBe(9);
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBeGreaterThanOrEqual(-32099);
      expect(response.error?.code).toBeLessThanOrEqual(-32000);
      // The pre-fix behaviour this restores: total, coerced to text, rather
      // than thrown.
      expect(response.error?.message).toContain("undefined");
    });
  });
});

describe("toRepoRelativeMessage", () => {
  // The regression this wave's review found: an earlier version assumed its
  // argument's `.message` was a string whenever `error instanceof Error`
  // was true. `instanceof Error` says nothing about what `.message` was
  // reassigned to after construction, so it wasn't. Exercised directly
  // (rather than only through withNonStringMessageGuardian's HTTP round
  // trip) so every shape of `unknown` a catch clause can hand it is covered
  // without standing up a Guardian for each one.
  it("never throws, for an Error whose .message is not a string", () => {
    const undefinedMessage = new Error("erased below");
    (undefinedMessage as { message: unknown }).message = undefined;
    const numberMessage = new Error("erased below");
    (numberMessage as { message: unknown }).message = 42;
    const objectMessage = new Error("erased below");
    (objectMessage as { message: unknown }).message = { nested: true };

    expect(toRepoRelativeMessage(undefinedMessage)).toBe("undefined");
    expect(toRepoRelativeMessage(numberMessage)).toBe("42");
    expect(toRepoRelativeMessage(objectMessage)).toBe("[object Object]");
  });

  it("is total for non-Error unknown values too, matching what a catch clause can hand it", () => {
    expect(toRepoRelativeMessage("a plain string")).toBe("a plain string");
    expect(toRepoRelativeMessage(42)).toBe("42");
    expect(toRepoRelativeMessage(null)).toBe("null");
    expect(toRepoRelativeMessage(undefined)).toBe("undefined");
    expect(toRepoRelativeMessage({ some: "object" })).toBe("[object Object]");
  });

  // This file's own REPO_ROOT (above, line 190) keeps the trailing slash
  // `fileURLToPath` gives a directory URL -- fine for join()ing against,
  // but these two tests need the bare root, with nothing after it, to build
  // "root + separator + subpath" and "root + suffix" strings without
  // accidentally doubling or misplacing a slash.
  const REPO_ROOT_BARE = REPO_ROOT.replace(/[/\\]+$/, "");

  it("strips this repo's root, with or without a trailing separator", () => {
    expect(toRepoRelativeMessage(new Error(`${REPO_ROOT_BARE}/packages/spec/acs`))).toBe("packages/spec/acs");
    expect(toRepoRelativeMessage(new Error(REPO_ROOT_BARE))).toBe("");
  });

  // Recommended fix, same wave: the un-anchored version matched REPO_ROOT as
  // a bare prefix, so a *sibling* directory whose name merely extends the
  // root (a `_old` backup clone, say) had its shared prefix stripped too --
  // not a disclosure of this tree's own location, since it names a
  // different directory entirely, but a misleading diagnostic that then
  // reads as if it were a path under this repo.
  it("leaves a sibling directory whose name extends the repo root untouched", () => {
    const siblingPath = `${REPO_ROOT_BARE}_old/packages/spec`;

    expect(toRepoRelativeMessage(new Error(siblingPath))).toBe(siblingPath);
  });
});

// PR #10 review, Critical: mapping.yaml's intervention_points table is what
// V7's conformance matrix publishes, and the runtime used to hardcode
// "pre_tool_call" instead of consulting it, so the two could disagree without
// anything failing.
describe("startGuardian POST /acs -- the intervention point comes from mapping.yaml", () => {
  it("evaluates the point the table names, not pre_tool_call: a moved row changes the decision", async () => {
    // The fixture answers steps/toolCallRequest with `output`, which
    // policy/manifest.yaml does not register -- so honouring the table makes
    // AGT fail closed, while ignoring it would allow this benign command. The
    // two outcomes are opposite: this cannot pass against a hardcoded point.
    const guardian = await startGuardian({
      port: 0,
      manifestPath: "policy/manifest.yaml",
      mappingPath: "packages/guardian/test/fixtures/mapping.tool-call-at-a-different-point.yaml",
    });

    try {
      const response = await postAcs(guardian.url, toolCallEnvelope("ls -la"));

      expect(response.error).toBeUndefined();
      expect(response.result?.decision).toBe("deny");
      expect(response.result?.reason_codes).toEqual(["runtime_error:intervention_point_unknown"]);
    } finally {
      await guardian.close();
    }
  });
});

// PR #10 review, Critical: Bun.serve with no `hostname` binds `*` -- every
// interface, dual-stack -- and this endpoint has no auth, no origin check and
// no request signing, so every host that could route to the port was a policy
// oracle and a policy sink. The observable that separates the two binds is
// reachability, so that is what is asserted, rather than the label Bun prints
// for the socket (`server.hostname` reads "localhost" for a wildcard bind,
// which is exactly the reading that hid this).
describe("startGuardian binds loopback only", () => {
  async function reachable(url: string): Promise<boolean> {
    try {
      await fetch(url, { method: "POST", body: "{}", signal: AbortSignal.timeout(2000) });
      return true;
    } catch {
      return false;
    }
  }

  it("refuses a connection to ::1, which a wildcard bind accepts", async () => {
    // `hostname: "::"` reproduces the pre-fix bind exactly: dual-stack
    // wildcard, ::1 and 127.0.0.1 both answering. It is the control, and it
    // is what stops the assertion below from passing vacuously on a machine
    // with no IPv6 loopback -- there, this expectation fails first and says
    // so, rather than letting an unreachable address look like a narrow bind.
    const wildcard = await startGuardian({ port: 0, hostname: "::", manifestPath: "policy/manifest.yaml" });
    const loopback = await startGuardian({ port: 0, manifestPath: "policy/manifest.yaml" });

    try {
      // Path and port both come from the url the Guardian reported, so the
      // probe cannot drift from what it actually serves.
      const wildcardEndpoint = new URL(wildcard.url);
      const loopbackEndpoint = new URL(loopback.url);

      expect(await reachable(`http://[::1]:${wildcardEndpoint.port}${wildcardEndpoint.pathname}`)).toBe(true);
      expect(await reachable(`http://127.0.0.1:${loopbackEndpoint.port}${loopbackEndpoint.pathname}`)).toBe(true);
      expect(await reachable(`http://[::1]:${loopbackEndpoint.port}${loopbackEndpoint.pathname}`)).toBe(false);
    } finally {
      await wildcard.close();
      await loopback.close();
    }
  });
});
