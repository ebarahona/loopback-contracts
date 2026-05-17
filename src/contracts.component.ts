import {
  Binding,
  BindingScope,
  createBindingFromClass,
  type Component,
} from '@loopback/core';
import {
  AsyncAPIEmitter,
  AvroEmitter,
  GraphQLEmitter,
  MockDataEmitter,
  ProtoEmitter,
  TypesEmitter,
  ZodEmitter,
} from './emitters';
import {
  EmitterRegistry,
  EmitterRunner,
  FileWriter,
  InMemoryLossyReporter,
  InMemoryConfigRegistry,
  InMemorySchemaRegistry,
  ManifestEmitterBooter,
  Pipeline,
  SourceResolverRegistry,
} from './engine';
import {ContractsEngineBindings} from './engine/tokens';
import {
  BarrelGenerator,
  ControllerGenerator,
  DatasourceGenerator,
  MetaSchemaWriter,
  ModelGenerator,
  RepositoryGenerator,
} from './generators';
import {ContractsBindings} from './keys';
import {
  GitSchemaSource,
  HttpSchemaSource,
  LocalSchemaSource,
  NpmSchemaSource,
} from './sources';

/**
 * The plugin's entry-point component.
 *
 * Applications register the engine by calling
 * `app.component(ContractsComponent)`. The component wires up every built-in
 * emitter, every built-in schema source, the DI-safe engine singletons
 * (lossy reporter, schema registry, file writer, emitter registry/runner,
 * source-resolver registry, pipeline, manifest-emitter booter), the
 * LB4-idiom emitters (model/repository/controller/datasource, tagged
 * under `EMITTER_TAG` with `tier: 'lb4-idiom'`), and the engine-internal
 * generators (barrel, meta-schema writer).
 *
 * Emitters and sources are discovered through their `@injectable` tag
 * metadata — `createBindingFromClass` lifts the `EMITTER_TAG` / `SOURCE_TAG`
 * tags off the class so {@link EmitterRegistry} and
 * {@link SourceResolverRegistry} pick them up via `@inject.view()`.
 *
 * Engine internals that are referenced by `BindingKey` (lossy reporter,
 * schema registry, source-resolver registry, pipeline) are bound at their
 * canonical key via `.toClass()`; everything else is class-as-key so
 * consumers `@inject(SomeClass)` directly.
 *
 * Deliberately **not** bound here: `ContractsBindings.PROJECT_PATHS`,
 * `ContractsBindings.TEMPLATE_ENGINE`, and `ContractsBindings.IMPORT_MAP`.
 * The backing classes (`DefaultProjectPaths`, `EjsTemplateEngine`,
 * `RelativeImportMap`) take runtime values in their constructors
 * (project root + parsed config, output directory, schema registry +
 * `getTargetPath` strategy). LB4's container cannot materialise those
 * arguments on its own, so a `.toClass()` binding would throw
 * `ResolutionError: <Class>.constructor[0]` the first time the pipeline
 * resolved the key. Bind these at runtime in the CLI / consumer code via
 * `app.bind(...).to(instance)` or `.toDynamicValue(...)` after
 * `app.component(ContractsComponent)`.
 *
 * @public
 */
export class ContractsComponent implements Component {
  readonly bindings: Binding<unknown>[] = [
    // -------------------------------------------------------------------
    // Built-in sidecar emitters. The `@injectable({tags: {...}})` decorator
    // on each class already declares the `EMITTER_TAG` + `kind` tags;
    // `createBindingFromClass` lifts them onto the resulting binding so
    // `EmitterRegistry`'s `@inject.view({tag: EMITTER_TAG})` picks them up.
    // -------------------------------------------------------------------
    createBindingFromClass(ZodEmitter),
    createBindingFromClass(TypesEmitter),
    // `openapi-components` and `cloudevents` are shipped as built-in
    // manifest emitters (src/emitters/manifest/<kind>/) discovered by the
    // ManifestEmitterBooter at startup — no class binding required here.
    createBindingFromClass(GraphQLEmitter),
    createBindingFromClass(AsyncAPIEmitter),
    createBindingFromClass(ProtoEmitter),
    createBindingFromClass(AvroEmitter),
    createBindingFromClass(MockDataEmitter),

    // -------------------------------------------------------------------
    // Built-in schema sources. Same pattern — tag metadata lives on the
    // class, the registry discovers them via the `SOURCE_TAG` view.
    // -------------------------------------------------------------------
    createBindingFromClass(LocalSchemaSource),
    createBindingFromClass(HttpSchemaSource),
    createBindingFromClass(GitSchemaSource),
    createBindingFromClass(NpmSchemaSource),

    // -------------------------------------------------------------------
    // Engine singletons that other engine classes inject by `BindingKey`.
    // Bind at the canonical key via `.toClass()` so a single instance
    // satisfies every consumer.
    //
    // Note: `TEMPLATE_ENGINE`, `PROJECT_PATHS`, and `IMPORT_MAP` are
    // *intentionally absent* from this list. Their backing classes take
    // non-DI constructor arguments (project root, parsed config, output
    // directory, target-path strategy) that the container cannot
    // materialise. The CLI / consumer code binds them at runtime — see the
    // class TSDoc above for the exact pattern.
    // -------------------------------------------------------------------
    Binding.bind(ContractsBindings.LOSSY_REPORTER)
      .toClass(InMemoryLossyReporter)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ContractsBindings.SCHEMA_REGISTRY)
      .toClass(InMemorySchemaRegistry)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ContractsBindings.CONFIG_REGISTRY)
      .toClass(InMemoryConfigRegistry)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ContractsEngineBindings.SOURCE_RESOLVER_REGISTRY)
      .toClass(SourceResolverRegistry)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ContractsEngineBindings.PIPELINE)
      .toClass(Pipeline)
      .inScope(BindingScope.SINGLETON),

    // -------------------------------------------------------------------
    // Engine singletons consumers reference by `BindingKey`. The pipeline
    // and runner inject these via `ContractsEngineBindings.*`, so we bind
    // each at its canonical key rather than relying on the default
    // `classes.<Name>` key `createBindingFromClass` would produce. The key
    // is part of the public name for these services — pinning it here
    // keeps the surface stable when the class is renamed.
    // -------------------------------------------------------------------
    Binding.bind(ContractsEngineBindings.FILE_WRITER)
      .toClass(FileWriter)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ContractsEngineBindings.EMITTER_REGISTRY)
      .toClass(EmitterRegistry)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(ContractsEngineBindings.EMITTER_RUNNER)
      .toClass(EmitterRunner)
      .inScope(BindingScope.SINGLETON),
    createBindingFromClass(ManifestEmitterBooter),

    // -------------------------------------------------------------------
    // LB4-idiom emitters (model, repo, controller, datasource). Same
    // `EMITTER_TAG` discovery channel as sidecars — `createBindingFromClass`
    // lifts the `@injectable({tags: {[EMITTER_TAG]: ..., kind: ...}})`
    // metadata onto the binding. The engine cannot tell sidecar emitters
    // and lb4-idiom emitters apart at the registry level; the `tier` field
    // on each emitter is what drives CLI defaults (sidecars = opt-in;
    // lb4-idiom = opt-out via `--no-emit-<kind>`).
    //
    // `override.ts` continues to inject them class-as-key through the
    // deprecated `generate()` back-compat shim each generator preserves.
    // -------------------------------------------------------------------
    createBindingFromClass(ModelGenerator),
    createBindingFromClass(RepositoryGenerator),
    createBindingFromClass(ControllerGenerator),
    createBindingFromClass(DatasourceGenerator),

    // -------------------------------------------------------------------
    // Engine-internal generators — not emitter contributions. Injected
    // class-as-key by the pipeline / writer pass.
    // -------------------------------------------------------------------
    createBindingFromClass(BarrelGenerator),
    createBindingFromClass(MetaSchemaWriter),
  ];
}
