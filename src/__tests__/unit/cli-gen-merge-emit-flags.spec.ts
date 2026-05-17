import {describe, expect, it} from 'vitest';
import {mergeEmitFlags, type ParsedFlags} from '../../cli/commands/gen';
import type {EmitValue, LoopbackConfigJson} from '../../types';

// --- precedence matrix ----------------------------------------------------
//
// `mergeEmitFlags` collapses three sources into the final emit-flag map
// the engine consumes:
//
//   1. Built-in defaults: every `lb4-idiom` kind defaults ON
//      (model/repository/controller/datasource), every sidecar kind
//      defaults OFF.
//   2. `config.emit` from `loopback.config.json` — boolean entries
//      override the defaults; the string-valued `esm` / `importExtension`
//      slots are filtered out.
//   3. CLI `--emit-<kind>` / `--no-emit-<kind>` overrides — these always
//      win, so a committed-to-disk `emit.zod: false` can still be
//      flipped on for a single run via `--emit-zod`.
//
// The user story the project commits to is: "I committed `emit.zod:
// false` to disk but want to enable it for one run via `--emit-zod`".
// These five cases pin every layer of that precedence chain.
//
// --------------------------------------------------------------------------

function baseConfig(
  emit: Readonly<Record<string, EmitValue>> = {},
): LoopbackConfigJson {
  const cfg: LoopbackConfigJson = {
    name: 'test',
    schemasDir: 'schemas',
    configsDir: 'configs',
    validator: 'ajv',
    schemas: [],
    emit,
  };
  return cfg;
}

function baseFlags(overrides: Record<string, boolean> = {}): ParsedFlags {
  return {
    watch: false,
    strict: false,
    allowBreaking: false,
    skipTsc: false,
    verbose: false,
    graphqlSdl: false,
    emitOverrides: overrides,
    esm: undefined,
    importExtension: undefined,
  };
}

describe('mergeEmitFlags', () => {
  it('defaults lb4-idiom kinds ON and sidecar kinds OFF when nothing else is set', () => {
    const merged = mergeEmitFlags(baseConfig(), baseFlags());
    expect(merged).toEqual({
      model: true,
      repository: true,
      controller: true,
      datasource: true,
    });
  });

  it('honors a config.emit boolean that flips a sidecar default ON', () => {
    const merged = mergeEmitFlags(baseConfig({zod: true}), baseFlags());
    expect(merged.zod).toBe(true);
  });

  it('honors a config.emit boolean that flips an lb4-idiom default OFF', () => {
    const merged = mergeEmitFlags(baseConfig({model: false}), baseFlags());
    expect(merged.model).toBe(false);
  });

  it('lets a CLI override win over a conflicting config.emit value', () => {
    const merged = mergeEmitFlags(
      baseConfig({zod: false}),
      baseFlags({zod: true}),
    );
    expect(merged.zod).toBe(true);
  });

  it('lets a CLI --no-emit override turn off a default-ON lb4-idiom kind', () => {
    const merged = mergeEmitFlags(baseConfig(), baseFlags({model: false}));
    expect(merged.model).toBe(false);
  });
});
