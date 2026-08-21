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
 *
 * `ACS_GUARDIAN_HOST` is left unset by default, which leaves startGuardian's
 * loopback bind in place -- see server.ts's header for why an unauthenticated
 * endpoint defaults to the narrowest bind. This is where a deployment that
 * needs a routable one says so, since env is this process's configuration
 * surface and server.ts reads none itself.
 */
import { startGuardian } from "./server.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_MANIFEST_PATH = "policy/manifest.yaml";

const port = Number(process.env.ACS_GUARDIAN_PORT ?? DEFAULT_PORT);
const hostname = process.env.ACS_GUARDIAN_HOST;
const manifestPath = process.env.ACS_MANIFEST_PATH ?? DEFAULT_MANIFEST_PATH;

const guardian = await startGuardian({ port, hostname, manifestPath });
console.log(`Guardian listening at ${guardian.url}`);
