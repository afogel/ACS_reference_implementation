/**
 * The Envelope Inspector's entrypoint -- `bun run inspector`.
 *
 * A third terminal beside `bun run guardian` and the agent host: it tails S6
 * and prints each ACS envelope as it crosses the wire. Not re-exported from
 * ./index.ts -- this is a process entrypoint, not a library call.
 *
 * `ACS_ENVELOPE_LOG` defaults to `.acs/envelopes.jsonl`, the same default
 * packages/guardian/src/main.ts writes to, so the two agree without either
 * hardcoding the other's value.
 */
import { tailEnvelopeLog } from "./tail-envelope-log.ts";
import { renderEnvelopeLogEntry } from "./render.ts";

const DEFAULT_ENVELOPE_LOG = ".acs/envelopes.jsonl";

const argv = process.argv.slice(2);
const fromStart = argv.includes("--from-start");
// `--envelope-log`, not `--path` (PR #11 review, second pass): this stream is
// the envelope log, and a later slice tails a second one beside it. A generic
// `--path` would have been the flag for whichever stream happened to come
// first, leaving the sibling to carry the qualifier -- the same asymmetry the
// `EnvelopeLogEntry` / `AuditEntry` rename closed one layer down. Named for its
// artifact now, so the pair reads as a pair when the second lands, and so each
// flag rhymes with the env var that overrides the same thing.
const envelopeLogFlag = argv.indexOf("--envelope-log");
const flagValue = envelopeLogFlag === -1 ? undefined : argv[envelopeLogFlag + 1];

if (envelopeLogFlag !== -1 && (flagValue === undefined || flagValue.startsWith("--"))) {
  console.error("usage: bun run inspector -- [--from-start] [--envelope-log <envelope log>]");
  process.exit(2);
}

const path = flagValue ?? process.env.ACS_ENVELOPE_LOG ?? DEFAULT_ENVELOPE_LOG;
const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const controller = new AbortController();
process.on("SIGINT", () => controller.abort());

console.log(`Envelope Inspector — tailing ${path}${fromStart ? " (from the start)" : ""}`);
console.log("Ctrl-C to stop.\n");

for await (const entry of tailEnvelopeLog({ path, fromStart, signal: controller.signal })) {
  console.log(renderEnvelopeLogEntry(entry, { color }));
  console.log("");
}
