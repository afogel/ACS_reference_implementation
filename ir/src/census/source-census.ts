/**
 * N11: `sourceCensus()` -- the declared corpus, checked against the tree.
 *
 * R1.1: corpus membership is determined by declared normative status, not
 * by RFC 2119 grep. `ir/census/sources.yaml` is authored: every document
 * under `docs/` appears exactly once with a status, and a normative one
 * says what makes it normative -- `self` for a pillar specification,
 * `reference` plus `referenced_by` for a page whose force comes from
 * elsewhere citing it: a pillar's "(normative)" citation (§7 cites
 * `provenance.md`, §8.4 cites `intent.md`) or the spec's own editorial
 * policy (`concepts/README.md` declares every concept page canonical).
 * A citation from an informative page confers nothing. This module never infers a status; it only checks that the
 * declaration and the tree agree, and every disagreement is a problem
 * that fails the census, because a document nobody classified is exactly
 * the silent omission R1.6 forbids.
 */

export type SourceStatus = "normative" | "informative" | "editorial";
export type NormativeBy = "self" | "reference";

export interface SourceDeclaration {
  /** Path relative to `docs/`. */
  path: string;
  status: SourceStatus;
  /** Required when `status` is `normative`. */
  normative_by?: NormativeBy;
  /** Required when `normative_by` is `reference`: `doc.md#anchor` citations that delegate normative force here. */
  referenced_by?: string[];
  /** Which pillar (or `concepts`) the document belongs to; informational. */
  pillar?: string;
  /** Why the editor classified it this way, in one line. */
  note?: string;
}

export interface SourceCensus {
  sources: SourceDeclaration[];
  /** Every way the declaration and the corpus disagree. Empty means the corpus is fully declared. */
  problems: string[];
}

const STATUSES: ReadonlySet<string> = new Set(["normative", "informative", "editorial"]);
const NORMATIVE_BY: ReadonlySet<string> = new Set(["self", "reference"]);

/** Parse the authored declaration file. Throws on a malformed record: the file is authored, so a shape error is an editing error. */
export function parseSourceDeclarations(yamlText: string): SourceDeclaration[] {
  const parsed: unknown = Bun.YAML.parse(yamlText);
  if (!isRecord(parsed) || !Array.isArray(parsed.sources)) {
    throw new Error("sources.yaml: expected a top-level `sources:` list");
  }
  return parsed.sources.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.path !== "string" || typeof entry.status !== "string") {
      throw new Error(`sources.yaml: entry ${index + 1} needs string \`path\` and \`status\``);
    }
    if (!STATUSES.has(entry.status)) {
      throw new Error(`sources.yaml: ${entry.path}: status must be one of normative | informative | editorial, got ${entry.status}`);
    }
    const declaration: SourceDeclaration = { path: entry.path, status: entry.status as SourceStatus };
    if (entry.normative_by !== undefined) {
      if (typeof entry.normative_by !== "string" || !NORMATIVE_BY.has(entry.normative_by)) {
        throw new Error(`sources.yaml: ${entry.path}: normative_by must be self | reference`);
      }
      declaration.normative_by = entry.normative_by as NormativeBy;
    }
    if (entry.referenced_by !== undefined) {
      if (!Array.isArray(entry.referenced_by) || !entry.referenced_by.every((r) => typeof r === "string")) {
        throw new Error(`sources.yaml: ${entry.path}: referenced_by must be a list of strings`);
      }
      declaration.referenced_by = entry.referenced_by as string[];
    }
    if (typeof entry.pillar === "string") declaration.pillar = entry.pillar;
    if (typeof entry.note === "string") declaration.note = entry.note;
    return declaration;
  });
}

export function sourceCensus(declared: SourceDeclaration[], corpusFiles: string[]): SourceCensus {
  const problems: string[] = [];
  const files = new Set(corpusFiles);
  const seen = new Set<string>();

  for (const source of declared) {
    if (seen.has(source.path)) problems.push(`${source.path}: declared more than once`);
    seen.add(source.path);
    if (!files.has(source.path)) problems.push(`${source.path}: declared but not in the corpus`);

    if (source.status === "normative") {
      if (!source.normative_by) {
        problems.push(`${source.path}: normative sources must say what makes them normative (normative_by: self | reference)`);
      } else if (source.normative_by === "reference") {
        if (!source.referenced_by?.length) {
          problems.push(`${source.path}: normative_by: reference needs a non-empty referenced_by`);
        }
        for (const ref of source.referenced_by ?? []) {
          const doc = ref.split("#", 1)[0] ?? "";
          if (!files.has(doc)) problems.push(`${source.path}: referenced_by cites ${doc}, which is not in the corpus`);
          const citing = declared.find((d) => d.path === doc);
          if (citing && citing.status === "informative") {
            problems.push(`${source.path}: referenced_by cites ${doc}, which is declared informative; a citation carries normative force only from a normative or editorial source`);
          }
        }
      }
    } else if (source.normative_by || source.referenced_by) {
      problems.push(`${source.path}: only normative sources carry normative_by / referenced_by`);
    }
  }

  for (const file of corpusFiles) {
    if (!seen.has(file)) problems.push(`${file}: in the corpus but not declared in sources.yaml`);
  }

  return { sources: declared, problems };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
