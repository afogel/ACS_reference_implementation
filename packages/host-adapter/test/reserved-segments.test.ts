/**
 * reserved-segments.ts's own tests: `RESERVED_SEGMENTS` and `findReservedKey`
 * in isolation, before either is exercised through a caller
 * (`modifications.ts`'s redaction/override checks, or a host applier's
 * rendered-value walk). See that module's own header for the duplication
 * this file's subjects retire and the two-job distinction that stays split
 * (§V5 review round 3, Task 3).
 */
import { describe, expect, it } from "bun:test";
import { findReservedKey, RESERVED_SEGMENTS } from "../src/reserved-segments.ts";

describe("RESERVED_SEGMENTS", () => {
  it("names exactly the three JavaScript prototype-machinery segments", () => {
    expect([...RESERVED_SEGMENTS].sort()).toEqual(["__proto__", "constructor", "prototype"]);
  });
});

describe("findReservedKey", () => {
  it("finds nothing in a value that owns none of the three names, at any depth", () => {
    expect(findReservedKey({ env: { PATH: "/bin" }, list: [{ a: 1 }] }, "value")).toBeUndefined();
  });

  it("finds nothing for a primitive, null, or undefined value", () => {
    expect(findReservedKey("x", "value")).toBeUndefined();
    expect(findReservedKey(42, "value")).toBeUndefined();
    expect(findReservedKey(null, "value")).toBeUndefined();
    expect(findReservedKey(undefined, "value")).toBeUndefined();
  });

  it("finds a reserved key owned at the top level", () => {
    const value = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(findReservedKey(value, "args")).toEqual({ path: "args.__proto__", key: "__proto__" });
  });

  it("finds a reserved key nested inside a plain object, at any depth", () => {
    const value = { env: { nested: { constructor: "x" } } };
    expect(findReservedKey(value, "args")).toEqual({
      path: "args.env.nested.constructor",
      key: "constructor",
    });
  });

  it("finds a reserved key nested inside an array element", () => {
    const value = { items: [{ safe: 1 }, { prototype: "x" }] };
    expect(findReservedKey(value, "result")).toEqual({ path: "result.items[1].prototype", key: "prototype" });
  });

  it("does not throw -- callers word and type their own refusal", () => {
    // Detection only, never a throw: modifications.ts needs
    // ModificationsInvalidError, apply-host-output.ts needs its own
    // mergeInPlace-specific wording, and this module owns neither
    // vocabulary (R3.2). See this file's own header.
    const value = JSON.parse('{"__proto__":{}}') as Record<string, unknown>;
    expect(() => findReservedKey(value, "args")).not.toThrow();
  });
});
