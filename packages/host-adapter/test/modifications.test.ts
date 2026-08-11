import { describe, expect, it } from "bun:test";
import { applyModifications, ModificationsInvalidError } from "../src/modifications.ts";

const ARGS = { command: "echo ghp_ABCDEF123456", timeout: 30 };

describe("applyModifications — §6.3", () => {
  it("overrides named arguments and leaves the rest", () => {
    expect(applyModifications(ARGS, { parameter_overrides: { command: "echo [REDACTED]" } }))
      .toEqual({ command: "echo [REDACTED]", timeout: 30 });
  });

  it("replaces a redacted field with its replacement, defaulting to [REDACTED]", () => {
    expect(applyModifications(ARGS, { redactions: [{ path: "/command" }] }))
      .toEqual({ command: "[REDACTED]", timeout: 30 });
    expect(applyModifications(ARGS, { redactions: [{ path: "/command", replacement: "***" }] }))
      .toEqual({ command: "***", timeout: 30 });
  });

  it("does not mutate the arguments it was given", () => {
    const original = { command: "keep me" };
    applyModifications(original, { parameter_overrides: { command: "changed" } });
    expect(original).toEqual({ command: "keep me" });
  });

  // Fix round 1, item 3: the only multi-segment path used elsewhere in this
  // suite ("/env/TOKEN") sits in a disjointness test that denies, so it
  // never reaches the apply loop -- setAtPath's recursive clone was correct
  // on trace but unexercised. This applies a depth-2 redaction for real and
  // checks both halves: the new value, and that the nested object it
  // descended into is left alone -- the half a shallow clone would break.
  it("applies a depth-2 redaction without mutating the nested object it descends into", () => {
    const original = { env: { TOKEN: "secret", OTHER: "keep" } };
    const result = applyModifications(original, { redactions: [{ path: "/env/TOKEN" }] });

    expect(result).toEqual({ env: { TOKEN: "[REDACTED]", OTHER: "keep" } });
    expect(original).toEqual({ env: { TOKEN: "secret", OTHER: "keep" } });
    expect(original.env).not.toBe(result.env);
  });

  it("throws on a modifications object that violates §6.3", () => {
    expect(() => applyModifications(ARGS, { modified_content: "x", redactions: [{ path: "/command" }] }))
      .toThrow(ModificationsInvalidError);
  });

  // Fix round 1, item 4: same rule as validateDecision's test above, at the
  // applyModifications level directly.
  it("throws on a redaction with an empty path", () => {
    expect(() => applyModifications(ARGS, { redactions: [{ path: "" }] })).toThrow(ModificationsInvalidError);
    expect(() => applyModifications(ARGS, { redactions: [{ path: "/" }] })).toThrow(ModificationsInvalidError);
  });

  // Fix round 1, item 5: a missing/non-string path must fail closed with a
  // clean ModificationsInvalidError, not a bare JS error surfaced from deep
  // inside the apply loop -- regardless of whether parameter_overrides is
  // also present.
  it("throws a clean ModificationsInvalidError on a missing or non-string redaction path, not raw JS error text", () => {
    expect(() => applyModifications(ARGS, { redactions: [{}] })).toThrow(ModificationsInvalidError);
    expect(() => applyModifications(ARGS, { redactions: [{ path: 42 }] })).toThrow(ModificationsInvalidError);
  });

  it("throws rather than creating an absent target, at either depth", () => {
    expect(() => applyModifications(ARGS, { parameter_overrides: { cmd: "x" } })).toThrow(ModificationsInvalidError);
    expect(() => applyModifications(ARGS, { redactions: [{ path: "/env/TOKEN" }] })).toThrow(ModificationsInvalidError);
    // Depth 2 where the first segment exists and the second does not.
    expect(() => applyModifications({ env: { OTHER: "x" } }, { redactions: [{ path: "/env/TOKEN" }] }))
      .toThrow(ModificationsInvalidError);
  });

  // A single-segment path still replaces the whole array wholesale; a
  // multi-segment path now legally descends into it via a real index.
  it("still replaces an array wholesale when the path names it directly", () => {
    expect(applyModifications({ items: ["a", "b"] }, { redactions: [{ path: "/items" }] }))
      .toEqual({ items: "[REDACTED]" });
    expect(applyModifications({ items: ["a", "b"] }, { redactions: [{ path: "/items/0" }] }))
      .toEqual({ items: ["[REDACTED]", "b"] });
  });

  it("applies a redaction addressing an array element", () => {
    const applied = applyModifications(
      { outputs: [{ value: "TOKEN=ghp_ABCDEF123456" }] },
      { redactions: [{ path: "/outputs/0/value", replacement: "TOKEN=[REDACTED]" }] },
    );
    expect(applied).toEqual({ outputs: [{ value: "TOKEN=[REDACTED]" }] });
    expect(Array.isArray((applied as { outputs: unknown }).outputs)).toBe(true);
  });

  // The reason array descent was rejected in V3: a naive setAtPath rewrites
  // the array as {"0": …}. That is not the edit that was asked for, and it
  // would reach the host as an object where it expects a list.
  it("keeps an array an array, and leaves its siblings alone", () => {
    const applied = applyModifications(
      { outputs: [{ value: "a" }, { value: "b" }] },
      { redactions: [{ path: "/outputs/1/value", replacement: "[REDACTED]" }] },
    );
    expect(applied).toEqual({ outputs: [{ value: "a" }, { value: "[REDACTED]" }] });
  });

  it("rejects an index past the end rather than growing the array", () => {
    expect(() =>
      applyModifications({ outputs: [{ value: "a" }] }, { redactions: [{ path: "/outputs/7/value" }] }),
    ).toThrow(/addresses "\/outputs\/7", which is not present in the arguments this tool call sent/);
  });

  it("rejects a non-numeric segment into an array", () => {
    expect(() =>
      applyModifications({ outputs: [{ value: "a" }] }, { redactions: [{ path: "/outputs/value" }] }),
    ).toThrow(/addresses "\/outputs\/value", which is not present in the arguments this tool call sent/);
  });

  // "-" is RFC 6901's append token. Appending is not redacting.
  it("rejects the JSON-pointer append token", () => {
    expect(() =>
      applyModifications({ outputs: [{ value: "a" }] }, { redactions: [{ path: "/outputs/-/value" }] }),
    ).toThrow(/addresses "\/outputs\/-", which is not present in the arguments this tool call sent/);
  });

  // An argument whose value is legitimately absent-looking must still be
  // editable: `hasOwnProperty`, not truthiness or `!== undefined`, is what
  // decides existence, so a null-valued argument is a real target.
  it("treats a null-valued argument as present", () => {
    expect(applyModifications({ command: null }, { parameter_overrides: { command: "echo hi" } }))
      .toEqual({ command: "echo hi" });
  });
});
