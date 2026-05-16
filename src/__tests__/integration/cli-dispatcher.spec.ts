// Dispatcher contract smoke-tests for `lb-contracts`. These guard the
// boundary between the dispatcher (`src/cli/index.ts`) and the command
// modules: every command file must export a `run(argv)` adapter so the
// dispatcher's `loadCommand` can route to it without throwing
// `CONTRACTS_CLI_BAD_COMMAND_MODULE`. The full per-command behavior is
// covered by the higher-fidelity `cli-init-contract-gen.spec.ts`; this
// file only asserts that the wiring is sound.
//
// We intentionally do not try to actually invoke `init` end-to-end here
// — Vitest workers disallow `process.chdir`, so we can't sandbox the run
// into a tmpdir, and the interactive prompt would block forever in CI.
// Instead, we directly import each command module and assert the
// dispatcher-facing `run` export exists with the expected shape. This is
// exactly what `loadCommand` in `src/cli/index.ts` checks for at
// runtime, so the contract is identical.

import {describe, expect, it} from 'vitest';

import {main} from '../../cli/index';

const COMMAND_MODULES = [
  '../../cli/commands/init',
  '../../cli/commands/contract',
  '../../cli/commands/ds',
  '../../cli/commands/override',
  '../../cli/commands/gen',
  '../../cli/commands/validate',
] as const;

describe('CLI dispatcher (src/cli/index.ts)', () => {
  it('returns 0 for `--help`', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
  });

  it('returns 0 for `-h`', async () => {
    const code = await main(['-h']);
    expect(code).toBe(0);
  });

  it('returns 0 for `--version`', async () => {
    const code = await main(['--version']);
    expect(code).toBe(0);
  });

  it('returns 0 for `-v`', async () => {
    const code = await main(['-v']);
    expect(code).toBe(0);
  });

  it('returns 1 for an unknown command', async () => {
    // Unknown commands print the help screen and exit 1 — they do NOT
    // throw `CONTRACTS_CLI_BAD_COMMAND_MODULE`, which would indicate the
    // dispatcher had loaded a command module whose `run` export was
    // missing (the regression this whole file guards against).
    const code = await main(['definitely-not-a-real-command']);
    expect(code).toBe(1);
  });

  it.each(COMMAND_MODULES)(
    'command module %s exports a callable run(argv)',
    async modulePath => {
      // Mirror what `loadCommand` in `src/cli/index.ts` does: dynamic
      // import the module and look for a `run` function on the
      // namespace (or `default.run`). A missing or non-function value
      // here is exactly what would surface as
      // `CONTRACTS_CLI_BAD_COMMAND_MODULE` from the dispatcher.
      const mod = (await import(modulePath)) as {
        run?: (argv: readonly string[]) => Promise<number>;
        default?: {run?: (argv: readonly string[]) => Promise<number>};
      };
      const run = mod.run ?? mod.default?.run;
      expect(typeof run).toBe('function');
    },
  );
});
