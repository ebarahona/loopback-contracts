import {Application, BindingScope} from '@loopback/core';
import {describe, expect, it} from 'vitest';
import {EmitterRegistry, EmitterRunner} from '../../engine';
import {ContractsEngineBindings} from '../../engine/tokens';
import {ContractsBindings} from '../../keys';

// --- contract -------------------------------------------------------------
//
// Cycle 2 removed the runner's explicit fail-fast guard for a missing
// `ConfigRegistry`, on the grounds that the non-optional
// `@inject(ContractsBindings.CONFIG_REGISTRY) configs: ConfigRegistry`
// constructor parameter IS the safety net — the container refuses to
// resolve the runner when the binding is missing. This spec pins that
// contract so a future regression (someone re-adding `{optional: true}`
// to the runner's `@inject`) is caught immediately.
//
// Every other runner test in the suite reaches the runner through an
// `app.component(ContractsComponent)` call, which transitively binds
// `CONFIG_REGISTRY` via `InMemoryConfigRegistry`. That convenience also
// masks the contract under test here — so this spec deliberately wires
// the runner WITHOUT the component, binds every other dependency by
// hand, and asserts that omitting `CONFIG_REGISTRY` makes the resolve
// throw.
//
// --------------------------------------------------------------------------

describe('EmitterRunner DI contract', () => {
  it('refuses to resolve when CONFIG_REGISTRY is not bound', async () => {
    const app = new Application();

    // Bind the runner itself plus its registry dependency — no
    // ContractsComponent, so nothing else lands implicitly.
    app
      .bind(ContractsEngineBindings.EMITTER_REGISTRY)
      .toClass(EmitterRegistry)
      .inScope(BindingScope.SINGLETON);
    app
      .bind(ContractsEngineBindings.EMITTER_RUNNER)
      .toClass(EmitterRunner)
      .inScope(BindingScope.SINGLETON);

    // Every per-emitter context input the runner injects, EXCEPT
    // CONFIG_REGISTRY. Stubs match the shape the runner forwards into
    // `EmitterContext`; none of them are exercised because resolution
    // fails before any method is called.
    app.bind(ContractsBindings.SCHEMA_REGISTRY).to({
      get: () => undefined,
      list: () => [],
      has: () => false,
    });
    app.bind(ContractsBindings.TEMPLATE_ENGINE).to({
      preload: async () => {},
      render: () => '',
    });
    app.bind(ContractsBindings.IMPORT_MAP).to({resolve: () => ''});
    app.bind(ContractsBindings.PROJECT_PATHS).to({
      root: '/tmp',
      outputDir: '/tmp/out',
      schemasDir: '/tmp/schemas',
      configsDir: '/tmp/configs',
    });
    app.bind(ContractsBindings.LOSSY_REPORTER).to({
      report: () => undefined,
      entries: () => [],
    });

    // CONFIG_REGISTRY intentionally NOT bound. Loopback's container
    // throws `ResolutionError` when a non-optional `@inject` resolves
    // against a missing binding. The check is name-based (rather than
    // an `instanceof`) so this stays robust if the framework relocates
    // the class export — `ResolutionError` is exposed through
    // `@loopback/core` -> `@loopback/context`, and the message embeds
    // the offending key, which is the second assertion below.
    await expect(
      app.get<EmitterRunner>(ContractsEngineBindings.EMITTER_RUNNER),
    ).rejects.toThrowError(/ResolutionError|not bound/);

    // Tighten: the failure must name CONFIG_REGISTRY specifically. If a
    // future change makes a different binding non-optional too, the
    // generic check above could pass for the wrong reason.
    await expect(
      app.get<EmitterRunner>(ContractsEngineBindings.EMITTER_RUNNER),
    ).rejects.toThrowError(/config-registry/);
  });
});
