/**
 * The Guardian's standalone CLI entrypoint -- `bun run guardian`.
 *
 * The tests use the Guardian in-process, calling `startGuardian` directly. The
 * demo needs it as a long-running process a hook subprocess can reach over
 * HTTP, so this file makes the runbook's "start the Guardian" step a real
 * command. Not re-exported from `./index.ts`: this is a process entrypoint,
 * not a library call.
 *
 * `ACS_GUARDIAN_PORT` defaults to 8787 -- the same default port
 * `hosts/claude-code/acs-hook.ts` assumes for `ACS_GUARDIAN_URL` when that
 * env var is unset, so the runbook and the shim agree without either
 * hardcoding the other's value.
 */
import { startGuardian } from "./server.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_MANIFEST_PATH = "policy/manifest.yaml";

const port = Number(process.env.ACS_GUARDIAN_PORT ?? DEFAULT_PORT);
const manifestPath = process.env.ACS_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH;

const guardian = await startGuardian({ port, manifestPath });
console.log(`Guardian listening at ${guardian.url}`);
