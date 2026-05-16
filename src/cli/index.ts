// Main CLI entrypoint and command dispatcher for `lb-contracts`. The
// shipped `bin/lb-contracts.js` requires the compiled form of this
// file; nothing else in the plugin imports it. The dispatcher's sole
// responsibilities are: route the first argv token to the right
// command file, render `--help` / `--version`, and format any thrown
// error into a single user-facing block on stderr.

import {ContractsError, ContractsValidationError} from '../helpers';
import {getVersion, renderHelp} from './help';
import {renderError} from './render-error';

/**
 * Subcommand handler signature. Each command file under
 * `src/cli/commands/` exports a `run(argv)` function matching this
 * shape; the dispatcher passes the argv slice that follows the
 * subcommand name.
 *
 * @internal
 */
type CommandRunner = (argv: readonly string[]) => Promise<number>;

/**
 * Lazy-load a command module by relative path. Lazy import keeps the
 * cold-start cost of `lb-contracts --help` to a minimum — only the
 * dispatched command's dependency graph is pulled in.
 *
 * @internal
 */
async function loadCommand(modulePath: string): Promise<CommandRunner> {
  // Dynamic import keeps the cold-start cost of `--help` / `--version` low.
  // Node's CJS `import()` interop resolves the module record's default-or-
  // namespace exports; either shape can land the `run` function.
  const mod = (await import(modulePath)) as {
    run?: CommandRunner;
    default?: {run?: CommandRunner};
  };
  const run = mod.run ?? mod.default?.run;
  if (typeof run !== 'function') {
    throw new ContractsError(
      'CONTRACTS_CLI_BAD_COMMAND_MODULE',
      `Command module '${modulePath}' does not export a run() function`,
    );
  }
  return run;
}

/**
 * Resolve the first positional token to a command module path plus the
 * remaining argv to pass through. `undefined` means "no command" and
 * the dispatcher renders the help screen.
 *
 * @internal
 */
function resolveCommand(argv: readonly string[]):
  | {
      modulePath: string;
      rest: readonly string[];
    }
  | undefined {
  const [head, ...rest] = argv;
  switch (head) {
    case 'init':
      return {modulePath: './commands/init', rest};
    case 'contract':
      return {modulePath: './commands/contract', rest};
    case 'ds':
      return {modulePath: './commands/ds', rest};
    case 'override':
      return {modulePath: './commands/override', rest};
    case 'gen':
      return {modulePath: './commands/gen', rest};
    case 'dev':
      // `dev` is the documented alias for `gen --watch`.
      return {modulePath: './commands/gen', rest: ['--watch', ...rest]};
    case 'validate':
      return {modulePath: './commands/validate', rest};
    default:
      return undefined;
  }
}

/**
 * Print the formatted error block to stderr. Centralised so the exit
 * paths stay symmetric.
 *
 * @internal
 */
function reportError(err: unknown): void {
  process.stderr.write(renderError(err));
}

/**
 * Top-level CLI dispatcher. Returns a process exit code; never calls
 * `process.exit` itself so the function is safely callable from tests
 * and from embedding harnesses.
 *
 * @param argv - The argv tail to dispatch (typically `process.argv.slice(2)`).
 * @returns Exit code in the range 0–255.
 *
 * @public
 */
export async function main(argv: readonly string[]): Promise<number> {
  // Help / version short-circuits — handled before any command load so
  // they never depend on a project being present.
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(renderHelp());
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    process.stdout.write(`${getVersion()}\n`);
    return 0;
  }

  const resolved = resolveCommand(argv);
  if (resolved === undefined) {
    process.stderr.write(`Unknown command: ${argv[0]}\n\n`);
    process.stderr.write(renderHelp());
    return 1;
  }

  try {
    const run = await loadCommand(resolved.modulePath);
    const code = await run(resolved.rest);
    return code | 0;
  } catch (err) {
    // Map known error shapes to exit codes; everything else is `1`.
    if (
      err instanceof ContractsError &&
      err.code === 'CONTRACTS_CLI_CANCELLED'
    ) {
      // SIGINT-equivalent exit code per UNIX convention.
      reportError(err);
      return 130;
    }
    if (err instanceof ContractsValidationError) {
      reportError(err);
      return 1;
    }
    reportError(err);
    return 1;
  }
}

/**
 * Detect whether this module was loaded as the process entry point
 * (i.e., via the `bin` shim). Importing the module for tests must NOT
 * trigger the auto-exit path.
 *
 * @internal
 */
function isCliEntry(): boolean {
  return (
    typeof require !== 'undefined' &&
    typeof module !== 'undefined' &&
    require.main === module
  );
}

if (isCliEntry()) {
  main(process.argv.slice(2)).then(
    code => {
      process.exit(code);
    },
    err => {
      // Last-resort: an error escaped `main` itself (should be
      // impossible — `main` catches everything).
      process.stderr.write(renderError(err));
      process.exit(1);
    },
  );
}
