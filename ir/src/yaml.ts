/**
 * A small, deterministic YAML emitter for the generated census files.
 *
 * `Bun.YAML.stringify` exists and is used nowhere here on purpose: its
 * output quotes and spaces keys in ways that make a regenerated file diff
 * noisily against the committed one, and the generated census is a
 * reviewable artifact whose whole value is a stable diff (R1.9, R7.2).
 * This emitter writes block style only -- maps in insertion order, lists
 * as `- ` items, scalars quoted only when YAML would otherwise misread
 * them -- and `Bun.YAML.parse` reads it back. The authored files are
 * parsed with `Bun.YAML.parse` and never written by a tool.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export function toYaml(value: YamlValue): string {
  const lines: string[] = [];
  emit(value, 0, lines);
  return lines.join("\n") + "\n";
}

function emit(value: YamlValue, depth: number, lines: string[]): void {
  const pad = "  ".repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${pad}[]`);
      return;
    }
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${scalar(item)}`);
      } else {
        // First line of the nested value shares the `- ` line.
        const before = lines.length;
        emit(item, depth + 1, lines);
        const first = lines[before];
        if (first !== undefined) lines[before] = `${pad}- ${first.trimStart()}`;
      }
    }
    return;
  }
  if (isScalar(value)) {
    lines.push(`${pad}${scalar(value)}`);
    return;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    lines.push(`${pad}{}`);
    return;
  }
  for (const [key, item] of entries) {
    if (item === undefined) continue;
    if (isScalar(item)) {
      lines.push(`${pad}${scalarKey(key)}: ${scalar(item)}`);
    } else if ((Array.isArray(item) && item.length === 0) || (!Array.isArray(item) && Object.keys(item).length === 0)) {
      lines.push(`${pad}${scalarKey(key)}: ${Array.isArray(item) ? "[]" : "{}"}`);
    } else {
      lines.push(`${pad}${scalarKey(key)}:`);
      emit(item, depth + 1, lines);
    }
  }
}

function isScalar(value: YamlValue): value is string | number | boolean | null {
  return value === null || typeof value !== "object";
}

function scalarKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key) ? key : JSON.stringify(key);
}

function scalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return needsQuoting(value) ? JSON.stringify(value) : value;
}

const RESERVED = /^(true|false|null|yes|no|on|off|~|y|n)$/i;

function needsQuoting(s: string): boolean {
  if (s.length === 0) return true;
  if (s !== s.trim()) return true;
  if (RESERVED.test(s)) return true;
  if (/^[-+]?(\d[\d_]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true;
  if (/^0x[0-9a-fA-F]+$/.test(s)) return true;
  if (/[\n\r\t"\\]/.test(s)) return true;
  if (/^[-?:,\[\]{}#&*!|>'"%@`]/.test(s)) return true;
  if (/: |:$| #/.test(s)) return true;
  return false;
}
