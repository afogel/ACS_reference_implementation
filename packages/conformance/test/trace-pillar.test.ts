import { describe, expect, it } from "bun:test";
import { renderTraceRows } from "../src/render.ts";
import { checkTracePillar, type TraceRow } from "../src/trace-pillar.ts";

const rows = checkTracePillar();

/** The one row named `attribute` -- most attributes in scope appear on
 * exactly one span, so a bare filter-and-assert-length-one is the natural
 * lookup. `gen_ai.tool.name` and `acs.session.id` are the two exceptions
 * (each required on more than one span) and are asserted separately below,
 * by their full row set rather than through this helper. */
function only(attribute: string): TraceRow {
  const matches = rows.filter((r) => r.attribute === attribute);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe("N49 -- checkTracePillar resolves every row against the v0.1.0 schema files at runtime", () => {
  it("gen_ai.tool.name is emittable on both spans that require it -- `tool.name` is required in both hook payloads that carry it", () => {
    const toolName = rows.filter((r) => r.attribute === "gen_ai.tool.name");
    // steps/toolCallRequest's gen_ai.tool.call and steps/toolCallResult's gen_ai.tool.result.
    expect(toolName.map((r) => r.span).sort()).toEqual(["gen_ai.tool.call", "gen_ai.tool.result"]);
    for (const row of toolName) {
      expect(row.emittableByWireConsumer).toBe(true);
      expect(row.wireSource).not.toBeNull();
      expect(row.reason).toBeUndefined();
    }
  });

  it("acs.capability is NOT emittable -- present but optional, and the reason names the optionality rather than claiming absence", () => {
    const row = only("acs.capability");
    expect(row.span).toBe("gen_ai.tool.call");
    expect(row.emittableByWireConsumer).toBe(false);
    // The field EXISTS on the wire (hooks/tool-call-request.json declares
    // "capability") -- this is the "present but optional" case, not the "no
    // such property" case, and wireSource must say so by being non-null.
    expect(row.wireSource).not.toBeNull();
    expect(row.wireSource).toContain("tool-call-request.json");
    expect(row.reason).toMatch(/optional/i);
    expect(row.reason).not.toMatch(/no wire source/i);
  });

  it("acs.decision is emittable -- AcsResult.decision is unconditionally required", () => {
    const row = only("acs.decision");
    expect(row.span).toBe("acs.decision");
    expect(row.emittableByWireConsumer).toBe(true);
    expect(row.wireSource).toContain("response-envelope.json");
    expect(row.reason).toBeUndefined();
  });

  it("acs.evaluator is NOT emittable -- no wire source at all, the other of the two reasons", () => {
    const row = only("acs.evaluator");
    expect(row.span).toBe("acs.decision");
    expect(row.emittableByWireConsumer).toBe(false);
    expect(row.wireSource).toBeNull();
    expect(row.reason).toMatch(/no wire source/i);
  });

  it("splits the four conditional decision attributes into the two reasons: acs.reasoning is present-but-optional, the other three are absent", () => {
    const reasoning = only("acs.reasoning");
    expect(reasoning.emittableByWireConsumer).toBe(false);
    expect(reasoning.wireSource).not.toBeNull(); // AcsResult.reasoning exists
    expect(reasoning.reason).toMatch(/optional/i);

    for (const attribute of ["acs.confidence", "acs.evaluator_version", "acs.model_id"]) {
      const row = only(attribute);
      expect(row.emittableByWireConsumer).toBe(false);
      expect(row.wireSource).toBeNull(); // no such AcsResult property at all
      expect(row.reason).toMatch(/no wire source/i);
    }
  });

  it("acs.provenance.origin is emittable -- provenance.json's own `required` list includes `origin`", () => {
    const row = only("acs.provenance.origin");
    expect(row.emittableByWireConsumer).toBe(true);
    expect(row.wireSource).toContain("provenance.json");
  });

  it("emittableByWireConsumer is false on every row whose wireSource is null, and that set is non-empty", () => {
    const noWireSource = rows.filter((r) => r.wireSource === null);
    expect(noWireSource.length).toBeGreaterThan(0);
    for (const row of noWireSource) {
      expect(row.emittableByWireConsumer).toBe(false);
    }
  });

  it("every not-emittable row carries a reason, and every emittable row carries none", () => {
    for (const row of rows) {
      expect(row.reason !== undefined).toBe(!row.emittableByWireConsumer);
    }
  });

  it("covers exactly the six in-scope spans' required attributes, plus decision_event's required and conditional attributes, plus provenance_attributes.required -- 17 rows total", () => {
    // 2 (toolCallRequest) + 2 (toolCallResult) + 1 (sessionStart) + 1
    // (sessionEnd) + 2 (userMessage) + 2 (agentResponse) = 10, plus 2
    // decision_event required + 4 conditional = 6, plus 1 provenance
    // required = 17.
    expect(rows).toHaveLength(17);
  });

  it("every row names a real span, never blank", () => {
    for (const row of rows) {
      expect(row.span.length).toBeGreaterThan(0);
    }
  });
});

describe("N52 -- renderTraceRows", () => {
  it("is a pure function of the rows it is handed -- rendering twice produces the same string", () => {
    expect(renderTraceRows(rows)).toBe(renderTraceRows(rows));
  });

  it("names every row's attribute, and says 'no wire source' for at least one row that has none", () => {
    const table = renderTraceRows(rows);
    for (const row of rows) {
      expect(table).toContain(row.attribute);
    }
    expect(table).toMatch(/no wire source/i);
  });

  it("renders the reason inline for a not-emittable row, not as a separate footnote system", () => {
    const table = renderTraceRows(rows);
    const capabilityReason = only("acs.capability").reason!;
    expect(table).toContain(capabilityReason);
  });

  it("RenderOptions.color is opt-in, and stripping the ANSI codes back out recovers exactly the plain render", () => {
    const plain = renderTraceRows(rows);
    const colored = renderTraceRows(rows, { color: true });
    expect(colored).not.toBe(plain);
    const stripped = colored.replace(/\x1b\[\d+m/g, "");
    expect(stripped).toBe(plain);
  });
});
