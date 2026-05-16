import {BindingKey} from '@loopback/core';
import type {EmitterRegistry} from './emitter-registry';
import type {EmitterRunner} from './emitter-runner';
import type {FileWriter} from './file-writer';
import type {Pipeline} from './pipeline';
import type {SourceResolverRegistry} from './source-resolver-registry';

/**
 * Engine-internal binding keys. Nothing under this namespace is re-exported
 * through `src/index.ts`; the keys exist purely so engine classes wire to
 * each other by token instead of forming hard import cycles or relying on
 * the brittle `classes.<Name>` default key `createBindingFromClass` would
 * synthesise.
 *
 * @internal
 */
export namespace ContractsEngineBindings {
  /** Singleton {@link SourceResolverRegistry}. */
  export const SOURCE_RESOLVER_REGISTRY =
    BindingKey.create<SourceResolverRegistry>(
      'platform.contracts.engine.source-resolver-registry',
    );

  /** Singleton {@link Pipeline} orchestrator. */
  export const PIPELINE = BindingKey.create<Pipeline>(
    'platform.contracts.engine.pipeline',
  );

  /** Singleton {@link EmitterRegistry}. */
  export const EMITTER_REGISTRY = BindingKey.create<EmitterRegistry>(
    'platform.contracts.engine.emitter-registry',
  );

  /** Singleton {@link EmitterRunner}. */
  export const EMITTER_RUNNER = BindingKey.create<EmitterRunner>(
    'platform.contracts.engine.emitter-runner',
  );

  /** Singleton {@link FileWriter}. */
  export const FILE_WRITER = BindingKey.create<FileWriter>(
    'platform.contracts.engine.file-writer',
  );

  /**
   * String binding key under which the CLI publishes the absolute project
   * root path. Stored as a string (not a `BindingKey<string>`) because the
   * CLI binds via the legacy `app.bind(<string>)` form for symmetry with
   * the existing engine-side consumers that look up the value through
   * `@inject('platform.contracts.project-root')`. Centralising the literal
   * here keeps the four-call-site duplication in the CLI from drifting.
   */
  export const PROJECT_ROOT_TAG = 'platform.contracts.project-root';
}
