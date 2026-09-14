/**
 * The ordinary-code half of E7.1: RFC 8785 (JCS) canonicalization, SHA-256,
 * §8.2's chain hash, and §10's signed input. None of this is Datalog, and
 * none of it belongs there (R3.5); these functions produce the `external`
 * relations the vocabulary declares.
 *
 * JCS is JSON with object keys sorted by UTF-16 code units, no whitespace,
 * and ES6 number serialization, which is what `JSON.stringify` already does
 * for numbers, so canonicalization here is a sorted-key stringify.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * §8.2: `entry_hash = lowercase-hex(SHA-256(content_bytes || prev_hash_bytes))`,
 * content_bytes the UTF-8 JCS of the entry with `entry_hash` and
 * `previous_hash` removed, prev_hash_bytes the raw 32 bytes of
 * `previous_hash` or empty for the first entry.
 */
export function chainEntryHash(entry: Record<string, unknown>): string {
  const { entry_hash: _h, previous_hash, ...rest } = entry;
  const content = Buffer.from(canonicalize(rest), "utf8");
  const prev = typeof previous_hash === "string" && previous_hash.length > 0 ? Buffer.from(previous_hash, "hex") : Buffer.alloc(0);
  return createHash("sha256").update(Buffer.concat([content, prev])).digest("hex");
}

/** §10: the JCS canonicalization of the envelope with `signature` removed, UTF-8. */
export function signedInput(envelope: Record<string, unknown>): { bytes: Buffer; coversChainHash: boolean } {
  const stripped = stripSignature(envelope);
  const bytes = Buffer.from(canonicalize(stripped), "utf8");
  return { bytes, coversChainHash: findKey(stripped, "chain_hash") };
}

/** `signature` lives in `params` on a request and in `result` on a response; strip wherever it is, top level included. */
function stripSignature(envelope: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(envelope)) {
    if (k === "signature") continue;
    if ((k === "params" || k === "result") && typeof v === "object" && v !== null && !Array.isArray(v)) {
      const inner = { ...(v as Record<string, unknown>) };
      delete inner.signature;
      out[k] = inner;
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function findSignature(envelope: Record<string, unknown>): { algorithm: string; value: string; key_id: string } | null {
  for (const holder of [envelope, envelope.params, envelope.result]) {
    if (typeof holder !== "object" || holder === null) continue;
    const sig = (holder as Record<string, unknown>).signature;
    if (typeof sig === "object" && sig !== null) {
      const s = sig as Record<string, unknown>;
      if (typeof s.algorithm === "string" && typeof s.value === "string" && typeof s.key_id === "string") return { algorithm: s.algorithm, value: s.value, key_id: s.key_id };
    }
  }
  return null;
}

export type SignatureStatus = "valid" | "invalid" | "absent" | "unverifiable";

/** HMAC-SHA256 over the signed input with the deployment's key; base64 or hex `value` accepted. */
export function verifyHmac(envelope: Record<string, unknown>, key: Buffer): { status: SignatureStatus; coversChainHash: boolean } {
  const sig = findSignature(envelope);
  const { bytes, coversChainHash } = signedInput(envelope);
  if (!sig) return { status: "absent", coversChainHash };
  if (sig.algorithm !== "HMAC-SHA256") return { status: "unverifiable", coversChainHash };
  const expected = createHmac("sha256", key).update(bytes).digest();
  const given = decodeSignatureValue(sig.value);
  const valid = given !== null && given.length === expected.length && timingSafeEqual(given, expected);
  return { status: valid ? "valid" : "invalid", coversChainHash };
}

export function signHmac(envelope: Record<string, unknown>, key: Buffer): string {
  return createHmac("sha256", key).update(signedInput(envelope).bytes).digest("base64");
}

function decodeSignatureValue(value: string): Buffer | null {
  if (/^[0-9a-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  try {
    const b = Buffer.from(value, "base64");
    return b.length > 0 ? b : null;
  } catch {
    return null;
  }
}

function findKey(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (Array.isArray(value)) return value.some((v) => findKey(v, key));
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === key && v !== undefined && v !== null) return true;
    if (findKey(v, key)) return true;
  }
  return false;
}
