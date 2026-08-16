/**
 * N41's SCHEMA leg -- the piece the plan's own slice accounting deferred to
 * this task ("schema leg on the pinned-clone path, Task 9"). `checkInterven-
 * tionPoints` (intervention-points.ts) measures whether mapping.yaml's
 * declared method round-trips through the runtime's own resolver; this
 * measures a different question about the same table -- whether the policy
 * input the Guardian actually constructs on the way there is a document AGT
 * itself would accept, checked against AGT's OWN `policy-input.schema.json`
 * rather than a hand-written mirror of it kept in this repo (R2.4: couple
 * only to a declared contract surface, and a copy of that surface authored
 * here could drift from upstream without this check saying so).
 *
 * `packages/agt-bridge/test/bridge.test.ts:134-140` already asserts the
 * constructed policy input has exactly the five members
 * `policy-input.schema.json` names (`additionalProperties: false` over
 * `intervention_point`, `policy_target`, `snapshot`, `annotations`, `tool`)
 * -- a shape assertion against a hand-written list. This is what turns it
 * into a check against AGT's real contract.
 *
 * SCOPED TO THE TWO POINTS THE GUARDIAN ACTUALLY CONSTRUCTS ONE FOR:
 * `pre_tool_call` and `post_tool_call` -- the only two AGT intervention
 * points this codebase has a real snapshot assembler for at all
 * (`packages/guardian/src/assemble-snapshot.ts`'s `assemblePreToolCall-
 * Snapshot` / `assemblePostToolCallSnapshot`), and the same two N43 measures
 * for the identical reason. "The policy input the Guardian would send" is
 * only a real question at these two; AGT's other six points have no snapshot
 * shape anywhere in this codebase to construct one for, and inventing a
 * plausible-looking one here would measure this harness's own guess rather
 * than the Guardian's real behaviour -- the exact failure mode commitment 5
 * exists to prevent (see e.g. verdicts.ts's own header on the same point).
 *
 * DOES NOT FETCH. Mirrors `scripts/verify-pin.sh`'s own pattern exactly
 * (facts file): a shell script (`scripts/run-conformance.sh`) clones AGT at
 * the pinned ref into a scratch temp dir and hands the path in by
 * `UPSTREAM_AGT_CLONE`; this module self-skips -- returns `{ran: false}`,
 * never throws -- when that variable is absent, so `bun test` (which never
 * sets it) always exercises every check that does not need the network and
 * never performs one.
 *
 * A THROW, not a resolved finding, when a constructed policy input actually
 * FAILS validation -- the same choice `failure-domains.ts`'s
 * `assertEvaluationFailsClosed` makes for a broken invariant: this is not a
 * matrix cell (there is no verdict axis for a policy input; it is the same
 * document regardless of which verdict AGT eventually returns for it), and a
 * bridge that constructs a wire-invalid document is a real defect this
 * check must not fold into a quietly-published "did not validate" line.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { InterventionSnapshot, PolicyBridge } from "agt-bridge";

/** Names the variable `scripts/run-conformance.sh` sets after cloning AGT at
 * `agt.lock`'s pinned ref -- read here, and printed in the skip reason below,
 * so a reader of the runner's own output does not have to go and find the
 * name in this file to reproduce the leg locally. */
export const UPSTREAM_AGT_CLONE_ENV = "UPSTREAM_AGT_CLONE";

/** Confirmed present at `agt.lock`'s pinned ref (facts file). Relative to the
 * clone root `UPSTREAM_AGT_CLONE` names. */
const SCHEMA_RELATIVE_PATH = "policy-engine/spec/schema/wire/policy-input.schema.json";

/** Representative snapshots at the two points this leg covers -- the same
 * REDACTABLE / REDACTABLE_COMMAND shapes `test/identity.test.ts` drives
 * through the real bridge for the identical reason: real fixtures that
 * exercise AGT's transform path, not minimal stubs shaped by this check
 * (commitment 5). Order is this module's own reporting order. */
const PROBE_SNAPSHOTS: [point: "pre_tool_call" | "post_tool_call", snapshot: InterventionSnapshot][] = [
  [
    "pre_tool_call",
    {
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash", args: { command: "echo ghp_ONLYINCOMMAND999" }, id: "t1" },
      input: { ifc: { source_labels: ["public"] } },
    },
  ],
  [
    "post_tool_call",
    {
      envelope: { budgets: { tool_call_count: 0, token_count: 0, elapsed_seconds: 0, cost_usd: 0 } },
      tool_call: { name: "Bash" },
      tool_result: { outputs: [{ value: "TOKEN=ghp_ONLYINOUTPUT999\n" }] },
      input: { ifc: { source_labels: ["public"] } },
    },
  ],
];

export type SchemaLegResult =
  | { ran: false; reason: string }
  | { ran: true; points: string[] };

/**
 * Compiles AGT's own schema file out of `upstreamClone` -- never a schema
 * kept in this repo. `strictRequired: false` and `allowUnionTypes: true` are
 * the same two Ajv strict-mode opt-outs `packages/guardian/src/validate-
 * envelope.ts`'s `buildAjv` documents, needed here for a DIFFERENT
 * construct in AGT's schema for the same underlying reason: `$defs.snapshot`'s
 * `anyOf` branches (`{"required": ["agent"]}`, etc.) each declare no
 * `properties` of their own for the key they require -- the sibling
 * `agent`/`input`/... properties live on the enclosing `snapshot` schema, not
 * inside each branch -- which is Ajv's strictRequired check tripping on a
 * schema whose `required` and sibling `properties` are both real and both
 * satisfied, not a genuine authoring mistake in AGT's schema; `allowUnion-
 * Types` because `policy_target.kind` is typed `["string", "null"]`. Neither
 * check is a validation-SEMANTICS check -- confirmed by running these exact
 * settings against the schema fetched from the pinned ref and both probe
 * snapshots below: both validate `true`, not merely "this schema compiles".
 */
function buildValidator(upstreamClone: string) {
  const schemaPath = join(upstreamClone, SCHEMA_RELATIVE_PATH);
  const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
  const ajv = new Ajv2020({ strict: true, allErrors: true, strictRequired: false, allowUnionTypes: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export async function checkPolicyInputSchema(bridge: PolicyBridge): Promise<SchemaLegResult> {
  const upstreamClone = process.env[UPSTREAM_AGT_CLONE_ENV];
  if (!upstreamClone) {
    return {
      ran: false,
      reason:
        `${UPSTREAM_AGT_CLONE_ENV} is not set -- run \`bun run conformance\` (scripts/run-conformance.sh clones ` +
        `AGT at agt.lock's pinned ref and sets it) to run this leg; \`bun test\` alone never performs the fetch`,
    };
  }

  const validate = buildValidator(upstreamClone);
  const points: string[] = [];
  for (const [point, snapshot] of PROBE_SNAPSHOTS) {
    const evidence = await bridge.evaluateWithEvidence(point, snapshot);
    if (!validate(evidence.policyInput)) {
      throw new Error(
        `N41 schema leg: the policy input the Guardian would send at "${point}" failed AGT's own ` +
          `policy-input.schema.json (${SCHEMA_RELATIVE_PATH}) -- ${JSON.stringify(validate.errors)}`,
      );
    }
    points.push(point);
  }
  return { ran: true, points };
}
