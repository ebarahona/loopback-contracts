// Renders the `--help` / `-h` / no-args screen for `lb-contracts`. Pure
// function: builds the entire help string in memory and returns it.

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Read the plugin's own version from `package.json`. Resolved relative
 * to the compiled `dist/cli/help.js` location so the lookup works both
 * when invoked through the published binary and during local `tsx` runs.
 *
 * @internal
 */
function readPackageVersion(): string {
  try {
    const pkgPath = join(__dirname, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as {version?: string};
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * Build the full help screen as a single string with a trailing
 * newline. Lists the seven user-facing commands; `lb4 gen` accepts nine
 * `--emit-<kind>` flags listed in the EMIT FLAGS table, plus the
 * matching `--no-emit-<kind>` overrides documented under
 * `lb4 gen --help`.
 *
 * The emit-flags table is intentionally hard-coded. Querying
 * `EmitterRegistry` here would force `--help` to boot an LB4
 * `Application` and run component discovery, which would dominate the
 * cold-start cost of the very command users invoke to figure out what
 * the CLI does. Wiring registry-backed discovery is a v1.x enhancement
 * once we have a no-boot metadata path.
 *
 * @returns Multi-line help text ready to print to stdout.
 *
 * @public
 */
export function renderHelp(): string {
  const v = readPackageVersion();
  const lines: string[] = [
    `@ebarahona/loopback-contracts ${v}`,
    '',
    'USAGE',
    '  lb-contracts <command> [options]',
    '',
    'COMMANDS',
    '  init                   Scaffold a new contracts project (writes loopback.config.json)',
    '  contract <name>        Add a new contract (schema + config pair)',
    '  ds <name>              Add a datasource entry to datasources.json',
    '  override <kind> <name> Emit an extension stub for kind in {model, repository, controller, datasource}',
    '  gen                    Run the codegen pipeline (regenerate bases, sidecars, _meta)',
    '  gen --watch | dev      Continuous regen on save (chokidar)',
    '  validate               Run all validation gates without emitting',
    '',
    'GEN EMIT FLAGS',
    '  --emit-zod                Emit *.zod.ts sidecars',
    '  --emit-types              Emit *.types.ts sidecars',
    '  --emit-graphql            Emit *.graphql.ts sidecars (and *.graphql SDL if --emit-graphql-sdl)',
    '  --emit-cloudevents        Emit *.cloudevents.ts sidecars',
    '  --emit-asyncapi           Emit *.asyncapi.yaml sidecars',
    '  --emit-proto              Emit *.proto sidecars',
    '  --emit-avro               Emit *.avsc sidecars',
    '  --emit-openapi-components Emit *.openapi-components.yaml sidecars',
    '  --emit-mock-data          Emit *.mock.json sidecars',
    '',
    'GLOBAL FLAGS',
    '  --strict         Promote warnings (lossy translations, breaking diffs) to errors',
    '  --allow-breaking Bypass backward-compat refusal for version-pin bumps',
    '  -h, --help       Show help',
    '  -v, --version    Show version',
    '',
  ];
  return lines.join('\n');
}

/**
 * Convenience accessor that returns the same version string used in the
 * help screen header. Exposed so the dispatcher's `--version` branch can
 * stay a one-liner.
 *
 * @returns The semver string from `package.json`.
 *
 * @public
 */
export function getVersion(): string {
  return readPackageVersion();
}
