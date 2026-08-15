/**
 * The Envelope Inspector's entrypoint -- `bun run inspector`.
 *
 * A third terminal beside `bun run guardian` and the agent host: it tails
 * the envelope log and the audit log and prints each ACS envelope, plus
 * each audited fail-open proceed/blocked outcome, as they cross the wire.
 * Not re-exported from ./index.ts -- this is a process entrypoint, not a
 * library call.
 *
 * `ACS_ENVELOPE_LOG` defaults to `.acs/envelopes.jsonl`, the same default
 * packages/guardian/src/main.ts writes to, so the two agree without either
 * hardcoding the other's value. `ACS_AUDIT_LOG` defaults to
 * `.acs/audit.jsonl` the same way, for whatever writes the audit log.
 *
 * The two logs are tailed concurrently and independently -- neither waits
 * on the other, and the audit log's raw session identifier is never matched
 * against the envelope log's derived one (see tail-audit-log.ts's module doc
 * for the split, and render.ts's renderAuditEntry doc for how it is
 * labelled). The posture badge is reprinted every time an audit-log entry
 * changes it: the last posture *observed* in the audit log -- not the
 * negotiated one, which lives in a host-side store this package
 * deliberately does not read -- and the running count of audited fail-open
 * proceeds, which is the number this project exists to keep in front of a
 * human.
 */
import { tailAuditLog, type AuditEntry } from "./tail-audit-log.ts";
import { tailEnvelopeLog } from "./tail-envelope-log.ts";
import { tailSessionContextLog, type SessionContextLogEntry } from "./tail-session-context.ts";
import {
  renderAuditEntry,
  renderEnvelopeLogEntry,
  renderPostureBadge,
  renderSessionChain,
  type PostureBadgeState,
} from "./render.ts";

const DEFAULT_ENVELOPE_LOG = ".acs/envelopes.jsonl";
const DEFAULT_AUDIT_LOG = ".acs/audit.jsonl";
const DEFAULT_SESSION_CONTEXT_LOG = ".acs/session-context.jsonl";

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

const argv = process.argv.slice(2);
const fromStart = argv.includes("--from-start");
// `--envelope-log`, not `--path`: this stream is the envelope log, and this
// file tails a second one beside it. A generic `--path` would be the flag
// for whichever stream happened to come first, leaving the sibling to carry
// the qualifier -- the same asymmetry `EnvelopeLogEntry` / `AuditEntry`
// avoids one layer down. Named for its artifact, so the pair reads as a
// pair, and so each flag rhymes with the env var that overrides the same
// thing.
const envelopeLogFlag = flagValue(argv, "--envelope-log");
const auditLogFlag = flagValue(argv, "--audit-log");
const sessionContextLogFlag = flagValue(argv, "--session-context-log");

for (const [flag, value] of [
  ["--envelope-log", envelopeLogFlag] as const,
  ["--audit-log", auditLogFlag] as const,
  ["--session-context-log", sessionContextLogFlag] as const,
]) {
  if (argv.includes(flag) && (value === undefined || value.startsWith("--"))) {
    console.error(
      "usage: bun run inspector -- [--from-start] [--envelope-log <envelope log>] [--audit-log <audit log>] " +
        "[--session-context-log <session context log>]",
    );
    process.exit(2);
  }
}

const path = envelopeLogFlag ?? process.env.ACS_ENVELOPE_LOG ?? DEFAULT_ENVELOPE_LOG;
const auditPath = auditLogFlag ?? process.env.ACS_AUDIT_LOG ?? DEFAULT_AUDIT_LOG;
const sessionContextPath =
  sessionContextLogFlag ?? process.env.ACS_SESSION_CONTEXT_LOG ?? DEFAULT_SESSION_CONTEXT_LOG;
const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

console.log(
  `Envelope Inspector — tailing ${path}, ${auditPath}, and ${sessionContextPath}` +
    `${fromStart ? " (from the start)" : ""}`,
);
console.log("Ctrl-C to stop.\n");

let badgeState: PostureBadgeState = { posture: null, proceeds: 0 };
console.log(renderPostureBadge(badgeState, { color }));
console.log("");

function noteAuditEntry(entry: AuditEntry): void {
  console.log(renderAuditEntry(entry, { color }));
  console.log("");

  // An ungoverned line carries no posture and is not a fail-open proceed, so
  // it moves neither half of the badge: it is a step nobody asked about, not
  // a bypass of a decision this deployment wanted made, and folding it into
  // `proceeds` would inflate the one number an operator reads to decide
  // whether the Guardian is healthy. It still prints above -- the badge
  // summarises the posture, the stream is where the skips are visible.
  const next: PostureBadgeState =
    entry.outcome === "ungoverned"
      ? badgeState
      : { posture: entry.posture, proceeds: badgeState.proceeds + (entry.outcome === "proceeded" ? 1 : 0) };
  if (next.posture !== badgeState.posture || next.proceeds !== badgeState.proceeds) {
    badgeState = next;
    console.log(renderPostureBadge(badgeState, { color }));
    console.log("");
  }
}

async function pumpEnvelopeLog(): Promise<void> {
  for await (const entry of tailEnvelopeLog({ path, fromStart, signal: controller.signal })) {
    console.log(renderEnvelopeLogEntry(entry, { color }));
    console.log("");
  }
}

async function pumpAuditLog(): Promise<void> {
  for await (const entry of tailAuditLog({ path: auditPath, fromStart, signal: controller.signal })) {
    noteAuditEntry(entry);
  }
}

// Every S3 entry seen so far, in the order tailSessionContextLog yielded
// them -- kept around because renderSessionChain (U22) checks a row against
// its session's own predecessor, which can be several entries back once
// other sessions' rows have interleaved (see tail-session-context.ts's
// module doc). Re-rendering the whole accumulated chain on each new entry
// and printing only its own row -- the last line of that render -- is what
// lets each printed row still carry a correct chain-break marker without
// reprinting every row that came before it.
let sessionChain: SessionContextLogEntry[] = [];

function noteSessionContextEntry(entry: SessionContextLogEntry): void {
  sessionChain = [...sessionChain, entry];
  const rendered = renderSessionChain(sessionChain, { color });
  const rows = rendered.split("\n");
  console.log(rows[rows.length - 1]);
  console.log("");
}

async function pumpSessionContextLog(): Promise<void> {
  for await (const entry of tailSessionContextLog({ path: sessionContextPath, fromStart, signal: controller.signal })) {
    noteSessionContextEntry(entry);
  }
}

await Promise.all([pumpEnvelopeLog(), pumpAuditLog(), pumpSessionContextLog()]);
