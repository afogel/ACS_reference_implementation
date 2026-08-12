/**
 * One redacted leaf, three path dialects, and the two that CAN agree by
 * derivation now do (PR #13 review, Important).
 *
 * A single rewrite is addressed three different ways along its route:
 *
 *   AGT   policy/manifest.yaml's `policy_target`, JSONPath over the SNAPSHOT
 *         (`$.tool_call.args.command`, `$.tool_result.outputs[0].value`)
 *   ACS   mapping.yaml's `into_argument` / `into_path`, addressing the ACS
 *         PAYLOAD (`command`, `/outputs/0/value`)
 *   host  the hookmap's `outputs.from` / `arguments`, addressing the HOST's own
 *         payload (`$.tool_response.stdout`)
 *
 * Their agreement used to be prose: three files, each with a comment telling the
 * reader to go and check another. Every new host or gate multiplies that tax,
 * and a comment is not a check -- moving `policy_target` one field over leaves
 * mapping.yaml describing a leaf nothing targets, and the demo simply stops
 * redacting.
 *
 * WHAT IS CHECKED HERE, AND WHY IT IS ONLY TWO OF THE THREE. The AGT and ACS
 * dialects address the SAME document -- AGT's snapshot is assembled from the ACS
 * payload, member for member (assemble-snapshot.ts) -- so one is derivable from
 * the other, and this file derives it. The host dialect is not derivable and
 * must not be: `$.tool_response.stdout` addresses a document this project does
 * not define, whose shape is the host's own. Absorbing that difference is the
 * hookmap's entire job and the reason the same adapter serves a second host, so
 * a check that "derived" it would be asserting a coincidence of this one
 * deployment. What keeps THAT seam honest is a different mechanism, one gate
 * over: `assertOutputIsReplaceable` refuses, before any decision is sought, a
 * deployment whose hookmap cannot address a replaceable leaf in the payload it
 * was handed.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

type ManifestPoint = { policy_target?: string; policy_target_kind?: string };
type Manifest = { intervention_points: Record<string, ManifestPoint> };

type MappingRule =
  | { into: "parameter_overrides"; into_argument: string }
  | { into: "redactions"; into_path: string };
type MappingPoint = { acs_method: string | null; modifications?: MappingRule };
type Mapping = { intervention_points: Record<string, MappingPoint> };

const manifest = Bun.YAML.parse(readFileSync("policy/manifest.yaml", "utf8")) as Manifest;
const mapping = Bun.YAML.parse(readFileSync("mapping.yaml", "utf8")) as Mapping;

/**
 * The ACS-side address of the leaf an AGT `policy_target` names.
 *
 * The two notations differ in exactly two ways, and both are mechanical:
 * AGT's path is rooted at the snapshot member for the gate (`tool_call.args`
 * for a request, `tool_result` for a result), and it uses JSONPath's dotted
 * and bracketed segments where ACS uses a JSON pointer.
 *
 * Throws rather than answering for a target it does not recognise: a silent
 * fallback would let a manifest edit pass this file by not matching any rule.
 */
function acsAddressOf(policyTarget: string): { kind: "argument" | "pointer"; address: string } {
  const argument = /^\$\.tool_call\.args\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(policyTarget);
  if (argument) {
    // ACS expresses a rewritten tool argument as parameter_overrides keyed by
    // argument NAME, so the ACS address is the leaf segment alone.
    return { kind: "argument", address: argument[1] as string };
  }

  const result = /^\$\.tool_result((?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])+)$/.exec(policyTarget);
  if (result) {
    // The ACS result payload IS what `$.tool_result` names, so the pointer is
    // the remainder with its segments rewritten: `.value` -> `/value`,
    // `[0]` -> `/0`.
    const pointer = (result[1] as string).replace(/\[(\d+)\]/g, ".$1").replace(/\./g, "/");
    return { kind: "pointer", address: pointer };
  }

  throw new Error(
    `this check does not know how to express the AGT policy_target ${JSON.stringify(policyTarget)} as an ACS ` +
      `address -- add the rule here rather than removing the point from the table below`,
  );
}

describe("the AGT and ACS dialects address the same leaf", () => {
  const gated = Object.entries(mapping.intervention_points).filter(([, row]) => row.modifications !== undefined);

  it("covers every point mapping.yaml gives a modifications rule", () => {
    // Not a fixed list: a third gate added to the table is a third row this
    // file has to check, and discovering them from the table is what makes
    // that automatic rather than remembered.
    expect(gated.map(([point]) => point).sort()).toEqual(["post_tool_call", "pre_tool_call"]);
  });

  for (const [point, row] of gated) {
    it(`${point}: mapping.yaml's land field is derivable from the manifest's policy_target`, () => {
      const policyTarget = manifest.intervention_points[point]?.policy_target;
      expect(policyTarget).toBeString();

      const derived = acsAddressOf(policyTarget as string);
      const rule = row.modifications as MappingRule;

      if (rule.into === "parameter_overrides") {
        expect(derived.kind).toBe("argument");
        expect(rule.into_argument).toBe(derived.address);
      } else {
        expect(derived.kind).toBe("pointer");
        expect(rule.into_path).toBe(derived.address);
      }
    });
  }

  it("fails when the two files disagree, which is the whole point", () => {
    // The drift this exists to catch, exercised directly: a manifest edited to
    // target a different argument while mapping.yaml still names the old one.
    expect(acsAddressOf("$.tool_call.args.script").address).not.toBe(
      (mapping.intervention_points.pre_tool_call?.modifications as { into_argument: string }).into_argument,
    );
  });

  it("refuses a policy_target shape it cannot express, rather than passing by default", () => {
    expect(() => acsAddressOf("$.tool_call.name")).toThrow(/does not know how to express/);
  });
});
