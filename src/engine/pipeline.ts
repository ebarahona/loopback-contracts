import {
  BindingScope,
  ContextView,
  filterByTag,
  inject,
  injectable,
} from '@loopback/core';
import {execFile} from 'node:child_process';
import {readdir, readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';
import Ajv2020 from 'ajv/dist/2020';
import type {ErrorObject, ValidateFunction} from 'ajv';
import createDebug from 'debug';

import {
  ContractsCodegenError,
  ContractsPipelineError,
  ContractsSourceError,
  ContractsValidationError,
  placeModelOutputs,
  readDatasourcesDoc,
  resolveIdReference,
  resolveRefTarget,
  walkJsonPointer,
} from '../helpers';
import type {
  ContractsValidator,
  EmittedFile,
  JSONSchema,
  LossyReport,
  MetaSchemaContributor,
  ProjectPaths,
  ValidatorContext,
} from '../interfaces';
import {ContractsBindings} from '../keys';
import type {
  DatasourceConfigJson,
  LoopbackConfigJson,
  ModelConfigJson,
} from '../types';
import {EmitterRegistry} from './emitter-registry';
import {EmitterRunner} from './emitter-runner';
import {FileWriter} from './file-writer';
import {BarrelGenerator} from '../generators/barrel-generator';
import {InMemoryConfigRegistry} from './config-registry';
import {InMemoryLossyReporter} from './lossy-reporter';
import {ModuleFormatTransformer} from './module-format-transformer';
import {
  buildDatasourcesMetaSchema,
  buildEmitterManifestMetaSchema,
  buildLoopbackConfigMetaSchema,
  buildModelConfigMetaSchema,
} from './meta-schema-generator';
import {InMemorySchemaRegistry} from './schema-registry';
import {
  BASELINE_FILENAME,
  baselinePath,
  classifySchemaChange,
  loadBaseline,
  ownEntry,
  schemaDigest,
  writeBaseline,
  type SchemaBaseline,
} from './schema-baseline';
import {
  isLocalSourceDescriptor,
  SourceResolverRegistry,
} from './source-resolver-registry';
import {ContractsEngineBindings} from './tokens';

const execFileAsync = promisify(execFile);
const debug = createDebug('loopback:contracts:pipeline');

/** Keywords whose values are instance data, never subschemas. */
const DATA_KEYWORDS: ReadonlySet<string> = new Set([
  'const',
  'default',
  'enum',
  'examples',
]);

/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  '$defs',
  'definitions',
  'dependentSchemas',
  'patternProperties',
  'properties',
]);

function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Input bundle the CLI hands {@link Pipeline.run}.
 *
 * @internal
 */
export interface PipelineRunOptions {
  /** Absolute path to the project root containing `loopback.config.json`. */
  readonly projectRoot: string;
  /** The parsed `loopback.config.json` document. */
  readonly config: LoopbackConfigJson;
  /** Resolved `--emit-<kind>` flags keyed by emitter `kind`. */
  readonly emitFlags: Record<string, boolean>;
  /** Promote `severity: 'error'` lossy reports to a stage failure. */
  readonly strict?: boolean;
  /**
   * Accept stage-6 breaking changes against the `contracts.lock.json`
   * baseline; the baseline is then updated after codegen succeeds.
   */
  readonly allowBreaking?: boolean;
  /** Skip the stage-8 `tsc --noEmit` gate (for `--dry-run`). */
  readonly skipTsc?: boolean;
  /**
   * Stop after the validation chain (stages 1-6) and skip stages 7-8 plus
   * the `contracts.lock.json` baseline write. The returned {@link PipelineResult} has
   * `filesWritten: []` and `tscOk: true`. Used by `lb-contracts validate`.
   */
  readonly validateOnly?: boolean;
  /**
   * Compute the `_meta/*.schema.json` documents in stage 5 but do not
   * write them to disk. Used by `lb-contracts validate` so the read-only
   * command never mutates the project tree.
   */
  readonly skipMetaSchemaWrite?: boolean;
  /**
   * Upper bound on the stage number to execute. The pipeline stops cleanly
   * after the named stage and returns the result so far. Mainly used by
   * `lb-contracts validate --stage <N>` to scope the run.
   */
  readonly maxStage?: StageNumber;
  /**
   * Module-format options resolved from CLI flags + `loopback.config.json`.
   * When `esm: true`, the engine inserts a {@link ModuleFormatTransformer}
   * pass between emitter output and FileWriter that rewrites relative
   * imports/exports to append `importExtension`, narrows type-only imports
   * via inline modifiers, and rejects any CJS syntax. Defaults to off.
   *
   * @see contracts-extensibility.md §"Module-format choice".
   */
  readonly moduleFormat?: {
    readonly esm?: boolean;
    readonly importExtension?: '.js' | '.ts' | '';
  };
}

/**
 * Per-run summary returned by {@link Pipeline.run}. Shape is append-only —
 * existing fields are never removed or renamed.
 *
 * @internal
 */
export interface PipelineResult {
  /** Absolute paths of files the engine wrote (created or updated). */
  readonly filesWritten: readonly string[];
  /** Lossy translations surfaced by emitters and engine stages. */
  readonly lossy: readonly LossyReport[];
  /** Whether stage 8 (`tsc --noEmit`) succeeded (true when skipped). */
  readonly tscOk: boolean;
  /** Number of stages that ran to completion (1-8). */
  readonly stagesRun: number;
}

/** Numeric stage labels surfaced on thrown errors. */
export type StageNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/**
 * Eight-stage validation + codegen pipeline. Owned by the engine; invoked
 * once per `lb-contracts gen` call.
 *
 * Each stage either passes and hands control to the next or throws a typed
 * error carrying contextual fields. Stage 7d (the actual file write) is the
 * only stage that touches the project's source tree; stages 1-6 are pure
 * validation gates and stage 8 is a post-write sanity check.
 *
 * @internal
 */
@injectable({scope: BindingScope.SINGLETON})
export class Pipeline {
  constructor(
    @inject(ContractsEngineBindings.SOURCE_RESOLVER_REGISTRY)
    private readonly sources: SourceResolverRegistry,
    @inject(ContractsBindings.SCHEMA_REGISTRY)
    private readonly registry: InMemorySchemaRegistry,
    @inject(ContractsEngineBindings.EMITTER_REGISTRY)
    private readonly emitters: EmitterRegistry,
    @inject(ContractsEngineBindings.EMITTER_RUNNER)
    private readonly runner: EmitterRunner,
    @inject(ContractsEngineBindings.FILE_WRITER)
    private readonly writer: FileWriter,
    @inject(ContractsBindings.PROJECT_PATHS)
    private readonly paths: ProjectPaths,
    @inject(ContractsBindings.LOSSY_REPORTER)
    private readonly lossy: InMemoryLossyReporter,
    @inject(ContractsBindings.CONFIG_REGISTRY)
    private readonly configs: InMemoryConfigRegistry,
    // `BarrelGenerator` is contributed by `ContractsComponent` via
    // `createBindingFromClass(BarrelGenerator)`, which lands it under
    // the LB4 default `classes.<Name>` namespace (see
    // `DEFAULT_TYPE_NAMESPACES` in `@loopback/context`'s
    // `binding-inspector`). Inject by the string key rather than the
    // class itself so we stay in lock-step with the component wiring
    // and never create a second sibling binding.
    @inject('classes.BarrelGenerator')
    private readonly barrels: BarrelGenerator,
    /**
     * Reactive view over every {@link ContractsValidator} bound under
     * {@link ContractsBindings.VALIDATOR_TAG}. Resolved at each `run()`
     * call; an empty view is a no-op. See {@link runValidators} for the
     * stage hook.
     */
    @inject.view(filterByTag(ContractsBindings.VALIDATOR_TAG))
    private readonly validatorsView: ContextView<ContractsValidator>,
    /**
     * Reactive view over every {@link MetaSchemaContributor} bound under
     * {@link ContractsBindings.META_SCHEMA_CONTRIBUTOR_TAG}. Walked in
     * stage 5 after each meta-schema is built and before it is queued
     * for write or used to compile a runtime validator.
     */
    @inject.view(filterByTag(ContractsBindings.META_SCHEMA_CONTRIBUTOR_TAG))
    private readonly metaSchemaContributorsView: ContextView<MetaSchemaContributor>,
  ) {}

  /**
   * Per-run buffer of files queued by validation stages (currently the
   * `_meta/*.schema.json` documents from stage 5). Held in memory until
   * stage 7d flushes them alongside emitter output so a stage 5/6 failure
   * never leaves partial writes on disk. Reset at the top of every
   * {@link run} call.
   */
  private writeQueue: EmittedFile[] = [];

  /**
   * `$id`s of the schemas loaded from a local (bare-path) source in the
   * current run. Stage 6 stores their full body in `contracts.lock.json`;
   * remote-source schemas are recorded by digest unless
   * `baseline.includeRemote` is set. Reset at the top of every {@link run}.
   */
  private localSchemaIds = new Set<string>();

  /**
   * Lazily-constructed Ajv2020 instance used by stages 2 and 5. Building
   * an Ajv instance compiles its meta-schema, which is non-trivial; the
   * pipeline is a singleton so the cost is amortised across every run
   * after the first. The instance is stateless across runs because we
   * never `addSchema` user content — `compile()` returns a fresh
   * validator scoped to the call site, and `getSchema('…2020-12/schema')`
   * pulls from Ajv2020's preloaded meta-schemas, both of which are safe
   * to reuse.
   */
  private cachedAjv: Ajv2020 | undefined;
  /**
   * Cached draft-2020-12 meta-schema validator, fetched once from
   * {@link cachedAjv}. Used by stage 2 to validate each authored schema
   * against the JSON Schema meta-schema.
   */
  private cachedMeta: ValidateFunction<unknown> | undefined;

  private getAjv(): Ajv2020 {
    if (this.cachedAjv === undefined) {
      this.cachedAjv = new Ajv2020({strict: false, allErrors: true});
    }
    return this.cachedAjv;
  }

  private getMetaValidator(): ValidateFunction<unknown> {
    if (this.cachedMeta === undefined) {
      const meta = this.getAjv().getSchema(
        'https://json-schema.org/draft/2020-12/schema',
      ) as ValidateFunction<unknown> | undefined;
      if (!meta) {
        // Ajv2020 ships the draft-2020-12 meta-schema preloaded; an
        // absent validator means the Ajv install itself is broken.
        throw new ContractsPipelineError(
          'stage 2 (schema validation): Ajv2020 meta-schema not registered',
          {stage: 'schema-validation'},
        );
      }
      this.cachedMeta = meta;
    }
    return this.cachedMeta;
  }

  /**
   * Recompile a meta-schema against the cached Ajv instance, evicting any
   * prior copy first. Required because Ajv's compiler cache rejects a
   * second `compile(metaSchema)` with the same `$id` — the watch-mode
   * pipeline calls `run()` repeatedly and would trip this on the second
   * iteration without the explicit `removeSchema`.
   *
   * This is the canonical way to (re)compile a meta-schema in this
   * engine. Adding a second inline `compile(buildXxxMeta())` call
   * elsewhere in stage 5 without going through this helper would
   * reintroduce the "schema with key … already exists" runtime error on
   * the second `run()` invocation in the same process.
   *
   * Implementation notes:
   *   - `removeSchema(id)` is a no-op on cold start; Ajv silently ignores
   *     an unknown `$id`, so the call is safe to make unconditionally
   *     whenever an `$id` is present.
   *   - When the meta-schema has NO `$id`, Ajv auto-assigns a unique
   *     cache key on `compile()` and the second compile won't collide —
   *     the `if (typeof id === 'string')` guard below skips the eviction
   *     in that case to make the helper's intent (evict by stable `$id`)
   *     explicit.
   */
  private compileFresh(metaSchema: JSONSchema): ValidateFunction {
    const ajv = this.getAjv();
    const id = (metaSchema as {$id?: string}).$id;
    if (typeof id === 'string') ajv.removeSchema(id);
    return ajv.compile(metaSchema as object);
  }

  /**
   * Execute the full pipeline. Returns the per-run summary; throws a typed
   * error on any stage failure. No partial writes — stage 7d only fires
   * once stages 1-6 all pass.
   *
   * @throws ContractsSourceError Stage 1.
   * @throws ContractsValidationError Stages 2, 3, 4, 5.
   * @throws ContractsPipelineError Stage 6 (when breaking + not allowed).
   * @throws ContractsCodegenError Stages 7, 8.
   */
  async run(opts: PipelineRunOptions): Promise<PipelineResult> {
    let stagesRun = 0;
    this.registry.clear();
    this.lossy.clear();
    this.configs._reset();
    this.writeQueue = [];
    this.localSchemaIds = new Set();
    const maxStage: StageNumber = opts.maxStage ?? 8;

    const fetched = await this.stage1Fetch(opts);
    stagesRun = 1;
    if (maxStage <= 1) return this.summarise(stagesRun);

    const parsed = await this.stage2Validate(fetched);
    stagesRun = 2;
    if (maxStage <= 2) return this.summarise(stagesRun);

    this.stage3Dedupe(parsed);
    stagesRun = 3;
    if (maxStage <= 3) return this.summarise(stagesRun);

    this.stage4ResolveRefs();
    stagesRun = 4;
    if (maxStage <= 4) return this.summarise(stagesRun);

    await this.stage5ValidateConfigs(opts);
    stagesRun = 5;
    if (maxStage <= 5) return this.summarise(stagesRun);

    const baseline = await this.stage6DiffBreakingChanges(opts);
    stagesRun = 6;
    if (maxStage <= 6) return this.summarise(stagesRun);

    // `--validate-only` short-circuits before codegen and before the
    // baseline write so the command remains read-only.
    if (opts.validateOnly === true) return this.summarise(stagesRun);

    // Run any `pre`-stage validators contributed via
    // `ContractsBindings.VALIDATOR_TAG` immediately before codegen, per
    // the {@link ContractsValidator} contract ("before any emitter
    // runs"). An empty validator set is a no-op.
    await this.runValidators('pre', opts);

    const writeResult = await this.stage7Codegen(opts);
    stagesRun = 7;

    // Advance the committed baseline (`contracts.lock.json`) only after
    // codegen wrote files: a failed stage 7 must not accept the change.
    const baselineWritten =
      baseline !== undefined &&
      (await writeBaseline(opts.projectRoot, baseline.next, baseline.raw));
    const written = [...writeResult.created, ...writeResult.updated];
    if (baselineWritten) written.push(baselinePath(opts.projectRoot));

    if (maxStage <= 7) {
      return {
        filesWritten: written,
        lossy: this.lossy.entries(),
        tscOk: true,
        stagesRun,
      };
    }

    // Run any `post`-stage validators between codegen and `tsc --noEmit`,
    // per the {@link ContractsValidator} contract ("after all emitters
    // have produced files, before `tsc --noEmit`"). An empty validator
    // set is a no-op.
    await this.runValidators('post', opts);

    const tscOk = await this.stage8Tsc(opts);
    stagesRun = 8;

    return {
      filesWritten: written,
      lossy: this.lossy.entries(),
      tscOk,
      stagesRun,
    };
  }

  /**
   * Build a {@link PipelineResult} for a validation-only or stage-capped
   * exit (no codegen ran, so no files were written and `tsc` was not
   * invoked — both treated as success for the purposes of the gate).
   */
  private summarise(stagesRun: number): PipelineResult {
    return {
      filesWritten: [],
      lossy: this.lossy.entries(),
      tscOk: true,
      stagesRun,
    };
  }

  // ----- Stage 1 -------------------------------------------------------

  private async stage1Fetch(opts: PipelineRunOptions): Promise<FetchedFile[]> {
    try {
      const results = await this.sources.resolveAll(opts.config.schemas);
      const out: FetchedFile[] = [];
      for (const batch of results) {
        for (const file of batch) {
          out.push({
            sourcePath: `${file.source}:${file.path}`,
            descriptor: file.source,
            content: file.content,
          });
        }
      }
      return out;
    } catch (err) {
      if (err instanceof ContractsSourceError) throw err;
      throw new ContractsPipelineError(
        `stage 1 (source fetch) failed: ${(err as Error).message}`,
        {stage: 'source-fetch'},
        {cause: err},
      );
    }
  }

  // ----- Stage 2 -------------------------------------------------------

  private async stage2Validate(
    fetched: readonly FetchedFile[],
  ): Promise<ParsedSchema[]> {
    const meta = this.getMetaValidator();

    const parsed: ParsedSchema[] = [];
    for (const file of fetched) {
      let json: unknown;
      try {
        json = JSON.parse(file.content);
      } catch (cause) {
        throw new ContractsValidationError(
          `stage 2: invalid JSON in ${file.sourcePath}: ${(cause as Error).message}`,
          {sourcePath: file.sourcePath, instancePath: ''},
          {cause},
        );
      }
      if (!isPlainObject(json)) {
        throw new ContractsValidationError(
          `stage 2: schema root must be an object in ${file.sourcePath}`,
          {sourcePath: file.sourcePath, instancePath: ''},
        );
      }
      const schema = json as JSONSchema;
      if (typeof schema.$id !== 'string' || schema.$id.length === 0) {
        throw new ContractsValidationError(
          `stage 2: schema in ${file.sourcePath} is missing top-level \`$id\``,
          {sourcePath: file.sourcePath, instancePath: ''},
        );
      }
      const schemaId = schema.$id;
      const ok = meta(schema as unknown);
      if (!ok) {
        throw new ContractsValidationError(
          `stage 2: schema in ${file.sourcePath} is not a valid Draft 2020-12 document:\n${formatAjvErrors(meta.errors)}`,
          {
            sourcePath: file.sourcePath,
            instancePath: meta.errors?.[0]?.instancePath ?? '',
            schemaId,
          },
        );
      }
      parsed.push({
        sourcePath: file.sourcePath,
        descriptor: file.descriptor,
        schema,
      });
    }
    return parsed;
  }

  // ----- Stage 3 -------------------------------------------------------

  private stage3Dedupe(parsed: readonly ParsedSchema[]): void {
    // Defer collision logic to InMemorySchemaRegistry.add — it canonicalises
    // and fingerprint-compares; same content silently dedupes and different
    // content throws ContractsCodegenError. Translate that into the stage-3
    // validation error so the CLI shows a uniform stage label.
    for (const p of parsed) {
      try {
        this.registry.add(p.schema);
        if (
          typeof p.schema.$id === 'string' &&
          isLocalSourceDescriptor(p.descriptor)
        ) {
          this.localSchemaIds.add(p.schema.$id);
        }
      } catch (cause) {
        const id = p.schema.$id ?? '';
        throw new ContractsValidationError(
          `stage 3: duplicate \`$id\` '${id}' with differing content in ${p.sourcePath}`,
          {sourcePath: p.sourcePath, instancePath: '/$id', schemaId: id},
          {cause},
        );
      }
    }
  }

  // ----- Stage 4 -------------------------------------------------------

  private stage4ResolveRefs(): void {
    for (const schema of this.registry.list()) {
      const rootId = typeof schema.$id === 'string' ? schema.$id : '<unknown>';
      this.walkResolveRefs(schema, rootId, schema, rootId, '');
    }
  }

  /**
   * Walk a schema resolving every `$ref` against the current base per
   * RFC 3986 §5.3 — JSON Schema 2020-12 §8.2.1.7 makes `$id` the base for
   * its enclosing subschema, so we update the base (and the document local
   * pointers resolve into) when descending into a subschema that declares
   * its own `$id`.
   *
   * Plain `$id`s (`money`, `appraisal-intake`) are first-class: references
   * resolve through {@link resolveRefTarget}, which resolves them against a
   * synthetic base URI and maps the result back to the plain registry key,
   * so `money`, `money#/$defs/amount` and `#/$defs/x` all resolve. The
   * synthetic base never appears in emitted names.
   *
   * `json-schema-traverse` exposes `jsonPtr` but not base-URI state, so we
   * recurse ourselves. Remote refs that don't resolve to a loaded schema
   * error — fetching remote refs is out of scope for v1.0.
   */
  private walkResolveRefs(
    node: unknown,
    baseId: string,
    document: unknown,
    rootId: string,
    path: string,
  ): void {
    if (Array.isArray(node)) {
      node.forEach((item, i) =>
        this.walkResolveRefs(item, baseId, document, rootId, `${path}/${i}`),
      );
      return;
    }
    if (!isPlainObject(node)) return;

    // Per RFC 3986 §5.3 — entering a subschema with its own `$id` rebases
    // every relative `$ref` beneath it and makes it the document that
    // same-document pointers resolve into.
    let currentBase = baseId;
    let currentDocument = document;
    const subId = node['$id'];
    if (typeof subId === 'string' && subId.length > 0 && node !== document) {
      // A malformed `$id` leaves the base unchanged; Ajv flags it in
      // stage 2 anyway.
      currentBase = resolveIdReference(subId, baseId) ?? baseId;
      currentDocument = node;
    }

    const ref = node['$ref'];
    if (typeof ref === 'string') {
      this.checkRef(ref, currentBase, currentDocument, rootId, `${path}/$ref`);
    }

    for (const [key, value] of Object.entries(node)) {
      // Instance data (`enum`, `const`, `examples`, `default`) is not a
      // schema, so a `$ref`-shaped value inside it is not a reference.
      if (key === '$id' || key === '$ref' || DATA_KEYWORDS.has(key)) continue;
      const keyPath = `${path}/${escapePointerToken(key)}`;
      // In a name-to-schema map every key is a name, even `$ref` / `$id`:
      // walk each value as a schema.
      if (SCHEMA_MAP_KEYWORDS.has(key) && isPlainObject(value)) {
        for (const [name, sub] of Object.entries(value)) {
          this.walkResolveRefs(
            sub,
            currentBase,
            currentDocument,
            rootId,
            `${keyPath}/${escapePointerToken(name)}`,
          );
        }
        continue;
      }
      this.walkResolveRefs(
        value,
        currentBase,
        currentDocument,
        rootId,
        keyPath,
      );
    }
  }

  private checkRef(
    ref: string,
    baseId: string,
    document: unknown,
    rootId: string,
    instancePath: string,
  ): void {
    const details = {sourcePath: rootId, instancePath, schemaId: rootId};
    if (ref.startsWith('git+') || ref.startsWith('npm:')) {
      throw new ContractsValidationError(
        `stage 4: remote \`$ref\` '${ref}' is out of scope for v1.0; ` +
          `move the target schema into a local source declared in \`loopback.config.json\``,
        details,
      );
    }

    // TODO(v1.1): RFC 3986 §6 URI equivalence — fold case-insensitive
    // scheme/host, drop default ports and normalise percent-encoding before
    // the registry lookup. Today two semantically-equal URL refs that differ
    // only in case or default-port form dangling-ref-error. Low impact in
    // practice (authors copy `$id` verbatim).
    const target = resolveRefTarget(ref, baseId, this.registry);
    if (target === undefined) {
      throw new ContractsValidationError(
        `stage 4: dangling \`$ref\` '${ref}' from schema '${rootId}' — ` +
          `no loaded schema has a matching \`$id\` (resolved against ` +
          `'${baseId}')`,
        details,
      );
    }

    // A fragment that is not a JSON Pointer is a `$anchor` name; Ajv
    // resolves those at compile time, so only pointers are walked here.
    if (!target.fragment.startsWith('/')) return;
    const targetDocument =
      target.id === baseId ? document : this.registry.get(target.id);
    if (walkJsonPointer(targetDocument, target.fragment) === undefined) {
      throw new ContractsValidationError(
        `stage 4: dangling \`$ref\` '${ref}' from schema '${rootId}' — ` +
          `'${target.id}' has no '#${target.fragment}'`,
        details,
      );
    }
  }

  // ----- Stage 5 -------------------------------------------------------

  private async stage5ValidateConfigs(
    opts: PipelineRunOptions,
  ): Promise<readonly DatasourceConfigJson[]> {
    // Load the raw `datasources.json` BEFORE normalisation so the
    // meta-schema's `oneOf` (array form vs keyed-map form) sees the
    // user's input shape rather than the post-normalise flat array.
    // ENOENT remains benign — `loadRawDatasources` returns `undefined`
    // when the file does not exist, and we skip meta-schema validation
    // for that case. Other I/O errors throw a `ContractsValidationError`
    // upstream, so reaching this point with a defined `rawDatasources`
    // means the file is on disk and parsed.
    const rawDatasources = await loadRawDatasources(opts.projectRoot);
    // Best-effort discovery of `loopback-connector-*` peers in the
    // project's `package.json` — the README documents `adapter` as a
    // project-specific enum sourced from installed connector peers, so
    // feeding the discovered list to `buildDatasourcesMetaSchema()`
    // upgrades IntelliSense from "any string" to the concrete enum.
    // Discovery failures (missing file, parse error) return `[]` and
    // fall back to the open-string behaviour.
    const installedAdapters = await discoverInstalledAdapters(opts.projectRoot);
    if (rawDatasources !== undefined) {
      // Compile via the engine's canonical compile-fresh helper so the
      // watch-mode rerun semantics (Ajv key-eviction by `$id`) hold —
      // see `compileFresh()` for the invariant.
      const datasourcesMeta = this.compileFresh(
        buildDatasourcesMetaSchema(installedAdapters) as JSONSchema,
      );
      const ok = datasourcesMeta(rawDatasources.raw);
      if (!ok) {
        throw new ContractsValidationError(
          `stage 5: datasources.json failed meta-schema validation:\n${formatAjvErrors(datasourcesMeta.errors)}`,
          {
            sourcePath: rawDatasources.path,
            instancePath: datasourcesMeta.errors?.[0]?.instancePath ?? '',
          },
        );
      }
    }
    const datasources = await loadDatasources(opts.projectRoot);
    const schemas = this.registry.list();

    // Regenerate every meta-schema. The model-config meta-schema is both
    // an authored aid (VS Code resolves `$schema` against it for
    // completion) and the validator we drive in this stage. Stage 5 used
    // to write the meta-schemas to disk inline, but that violated the
    // no-partial-writes guarantee: a stage 5 or 6 failure would leave
    // mutated meta-schemas behind. We now buffer the writes in
    // `writeQueue` and flush them in stage 7d alongside emitter output,
    // so any pre-codegen failure rolls back cleanly.
    // Snapshot the {@link MetaSchemaContributor} extension list once per
    // stage-5 invocation so every meta-schema below sees the same
    // contributor set (and ordering) regardless of how many of them
    // resolve. Empty list -> the helper returns its input untouched.
    const metaContributors = await this.metaSchemaContributorsView.values();

    // Each meta-schema is built, then passed through
    // {@link applyMetaSchemaContributors} so registered contributors can
    // augment it. Contributors run in registration (LB4 binding) order;
    // each receives the previous contributor's output, so a downstream
    // contributor can refine an upstream contribution. The CONTRIBUTED
    // copy is what we queue to disk AND what we compile into the
    // runtime validator below — meta-schema and validator stay in
    // lock-step.
    const modelConfigMeta = this.applyMetaSchemaContributors(
      '_meta/model-config.schema.json',
      buildModelConfigMetaSchema(schemas, datasources) as JSONSchema,
      metaContributors,
    );
    const datasourcesMeta = this.applyMetaSchemaContributors(
      '_meta/datasources.schema.json',
      buildDatasourcesMetaSchema(installedAdapters) as JSONSchema,
      metaContributors,
    );
    const emitterManifestMeta = this.applyMetaSchemaContributors(
      '_meta/emitter.schema.json',
      buildEmitterManifestMetaSchema() as JSONSchema,
      metaContributors,
    );
    // Collect the registered emitter kinds so the loopback-config meta-
    // schema can constrain `emit.*` boolean slots to the real kind enum
    // — a typo like `emit.zodd` then fails meta-schema validation
    // instead of silently disabling the intended emitter. CLI-side
    // validation in `cli-context.ts` compiles the same builder with an
    // empty enum, so this is the engine's "second validation pass" that
    // catches the typo.
    const emitterKinds = (await this.emitters.all()).map(e => e.kind);
    // Pass `schemas` and `datasources` so the loopback-config meta-
    // schema's `config-bindings.items` slot (Q5 fix) tightens inline
    // entries with the SAME enums as the standalone per-file pass:
    // `$contractId` constrained to loaded schema `$id`s, `dataSource`
    // constrained to declared datasource names.
    const loopbackConfigMeta = this.applyMetaSchemaContributors(
      '_meta/loopback-config.schema.json',
      buildLoopbackConfigMetaSchema(
        emitterKinds,
        schemas,
        datasources,
      ) as JSONSchema,
      metaContributors,
    );

    // INVARIANT: in-memory meta-schemas drive validation NOW; the queued
    // copies (`writeQueue` entries) reach disk only in stage 7d's atomic
    // commit. A stage 5/6 failure between queue and flush leaves the
    // previous `_meta/` revision on disk — that's the no-partial-writes
    // guarantee. Editor IntelliSense lag is acceptable because the next
    // successful `lb-contracts gen` re-queues the fresh shape.
    //
    // `lb-contracts validate` flips `skipMetaSchemaWrite` so the read-only
    // command never queues meta-schema writes. The meta-schemas are
    // still built above so the in-memory Ajv validators below see the
    // same shape `lb-contracts gen` would have written.
    if (opts.skipMetaSchemaWrite !== true) {
      this.queueMetaSchema('model-config.schema.json', modelConfigMeta);
      this.queueMetaSchema('datasources.schema.json', datasourcesMeta);
      this.queueMetaSchema('emitter.schema.json', emitterManifestMeta);
      this.queueMetaSchema('loopback-config.schema.json', loopbackConfigMeta);
    }

    // Second validation pass: enforce the strict-kinds meta-schema on
    // the in-memory `loopback.config.json`. CLI-side validation cannot
    // know the registered emitter set (the engine owns the registry),
    // so misspelled `emit.<kind>` slots slip through there. Run it
    // here, AFTER the meta-schema is queued (so the on-disk schema and
    // the runtime validator stay in lock-step) and using `compileFresh`
    // for watch-mode rerun safety.
    const loopbackConfigPath = join(opts.projectRoot, 'loopback.config.json');
    const loopbackConfigValidate = this.compileFresh(
      loopbackConfigMeta as JSONSchema,
    );
    const loopbackConfigOk = loopbackConfigValidate(opts.config);
    if (!loopbackConfigOk) {
      throw new ContractsValidationError(
        `stage 5: loopback.config.json failed meta-schema validation:\n${formatAjvErrors(loopbackConfigValidate.errors)}`,
        {
          sourcePath: loopbackConfigPath,
          instancePath: loopbackConfigValidate.errors?.[0]?.instancePath ?? '',
        },
      );
    }

    // Recompile the model-config meta-schema via the engine's canonical
    // compile-fresh helper — the meta-schema rebuilds from the current
    // schema + datasource set every run, so its shape (and thus its
    // hash) can change while keeping the same stable `$id`. Without the
    // `removeSchema` baked into `compileFresh`, Ajv would throw
    // 'schema with key … already exists' on the second `run()` call in
    // the same process (watch mode).
    //
    // INVARIANT: `buildModelConfigMetaSchema` must always set a stable,
    // non-empty `$id` on the returned schema — `compileFresh` evicts by
    // `$id`, so a future change that drops or randomises the `$id`
    // would reintroduce the "schema with key already exists" diagnostic
    // because the cached copy could no longer be located for removal.
    // Keep the `$id` stable.
    const validate = this.compileFresh(modelConfigMeta as JSONSchema);

    // Validate every configs/*.config.json on disk.
    const configFiles = await listConfigFiles(this.paths.configsDir);
    // stage-5 must leave the registry either fully populated or fully empty — no
    // partial state. The try below encloses BOTH the per-file disk-config
    // populate loop AND the follow-up inline `config-bindings` validation so
    // that any throw from either step triggers `_reset()` before rethrow.
    try {
      for (const file of configFiles) {
        const raw = await readFile(file, 'utf8');
        let json: unknown;
        try {
          json = JSON.parse(raw);
        } catch (cause) {
          throw new ContractsValidationError(
            `stage 5: invalid JSON in ${file}: ${(cause as Error).message}`,
            {sourcePath: file, instancePath: ''},
            {cause},
          );
        }
        const ok = validate(json);
        if (!ok) {
          const candidate = isPlainObject(json)
            ? (json as unknown as ModelConfigJson)
            : undefined;
          const contractId =
            candidate && typeof candidate.$contractId === 'string'
              ? candidate.$contractId
              : undefined;
          throw new ContractsValidationError(
            `stage 5: config ${file} failed meta-schema validation:\n${formatAjvErrors(validate.errors)}`,
            {
              sourcePath: file,
              instancePath: validate.errors?.[0]?.instancePath ?? '',
              ...(contractId !== undefined ? {schemaId: contractId} : {}),
            },
          );
        }
        // Validation passed — load into the per-contract config registry so
        // lb4-idiom-tier emitters (model/repository/controller/datasource)
        // can look up their LB4 metadata by `$contractId` at emit time.
        if (isPlainObject(json)) {
          // Ajv validated against buildModelConfigMetaSchema(); the shape is `ModelConfigJson` by construction.
          const config = json as unknown as ModelConfigJson;
          assertDatasourceDeclared(config, datasources, file);
          this.configs.add(config);
        }
      }

      // Validate inline `config-bindings` entries in `loopback.config.json`.
      // `LoopbackConfigJson['config-bindings']` is typed as
      // `readonly ModelConfigJson[]`, so `entry` is already `ModelConfigJson`
      // at destructure time — no `as unknown as ModelConfigJson` double-cast
      // needed. The single `as ModelConfigJson` below re-asserts the array
      // element type already declared on the field; Ajv's `validate(entry)`
      // guarantees the runtime shape matches before the registry add.
      const inline = opts.config['config-bindings'];
      if (Array.isArray(inline)) {
        const inlineConfigPath = join(opts.projectRoot, 'loopback.config.json');
        for (const [i, entry] of inline.entries()) {
          const ok = validate(entry);
          if (!ok) {
            const contractId =
              typeof entry.$contractId === 'string'
                ? entry.$contractId
                : '<unknown>';
            throw new ContractsValidationError(
              `stage 5: loopback.config.json.config-bindings[${i}] failed meta-schema validation:\n${formatAjvErrors(validate.errors)}`,
              {
                sourcePath: inlineConfigPath,
                instancePath: `/config-bindings/${i}${validate.errors?.[0]?.instancePath ?? ''}`,
                schemaId: contractId,
              },
            );
          }
          // Validation passed — load into the per-contract config registry so
          // lb4-idiom-tier emitters (model/repository/controller/datasource)
          // can look up their LB4 metadata by `$contractId` at emit time.
          const config = entry as ModelConfigJson;
          assertDatasourceDeclared(config, datasources, inlineConfigPath, i);
          this.configs.add(config);
        }
      }
    } catch (err) {
      this.configs._reset();
      throw err;
    }

    return datasources;
  }

  // ----- Stage 6 -------------------------------------------------------

  /**
   * Compare every loaded schema against its last accepted form in the
   * committed baseline (`contracts.lock.json`) and refuse breaking
   * changes. A schema with no baseline entry is new and passes; a
   * baseline entry whose schema is no longer loaded is a removed contract
   * and counts as breaking. A schema the baseline records only by digest
   * (a remote source, see `baseline.includeRemote`) cannot be classified,
   * so any change to it counts as breaking. `--allow-breaking` or
   * `migration-strategy.<schemaId>.mode = 'allow'` lets a breaking change
   * through. Returns the next baseline and the text it replaces, which
   * {@link run} writes only after codegen succeeds; `undefined` when
   * `baseline.enabled` is `false`.
   */
  private async stage6DiffBreakingChanges(
    opts: PipelineRunOptions,
  ): Promise<{next: SchemaBaseline; raw: string | undefined} | undefined> {
    const settings = opts.config.baseline;
    if (settings?.enabled === false) return undefined;
    const includeRemote = settings?.includeRemote === true;

    const loaded = await loadBaseline(opts.projectRoot);
    const previous = loaded?.baseline;
    const schemas = new Map<string, JSONSchema>();
    const digests = new Map<string, string>();
    const refusals: string[] = [];
    const refuse = (id: string, what: string): void => {
      const allowedByStrategy =
        ownEntry(opts.config['migration-strategy'], id)?.mode === 'allow';
      if (opts.allowBreaking !== true && !allowedByStrategy) {
        refusals.push(`'${id}': ${what}`);
      }
    };

    for (const schema of this.registry.list()) {
      const id = schema.$id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const digest = schemaDigest(schema);
      if (includeRemote || this.localSchemaIds.has(id)) {
        schemas.set(id, schema);
      } else {
        digests.set(id, digest);
      }
      const accepted = ownEntry(previous?.schemas, id);
      if (accepted !== undefined) {
        if (classifySchemaChange(accepted, schema) === 'breaking') {
          refuse(id, 'breaking change');
        }
        continue;
      }
      const acceptedDigest = ownEntry(previous?.digests, id);
      if (acceptedDigest !== undefined && acceptedDigest !== digest) {
        refuse(
          id,
          'changed (remote-source schema recorded by digest only, so the ' +
            'change cannot be classified; set `baseline.includeRemote` to ' +
            'store its body)',
        );
      }
    }
    const previousIds = new Set([
      ...Object.keys(previous?.schemas ?? {}),
      ...Object.keys(previous?.digests ?? {}),
    ]);
    for (const id of previousIds) {
      if (!schemas.has(id) && !digests.has(id)) refuse(id, 'schema removed');
    }

    if (refusals.length > 0) {
      throw new ContractsPipelineError(
        `stage 6: refusing to proceed; ${refusals.length} breaking schema ` +
          `change(s) against ${BASELINE_FILENAME}: ${refusals.join('; ')}. ` +
          `Re-run \`lb-contracts gen --allow-breaking\` to accept them and ` +
          `update the baseline, or declare ` +
          `\`migration-strategy.<schemaId>.mode = 'allow'\` in loopback.config.json.`,
        {stage: 'backward-compat-diff'},
      );
    }

    const next: SchemaBaseline = {
      version: 1,
      schemas: Object.fromEntries(schemas),
      digests: Object.fromEntries(digests),
    };
    return {next, raw: loaded?.raw};
  }

  // ----- Stage 7 -------------------------------------------------------

  // (Helper used by stage 7c.5; defined as a file-scope function below.)

  private async stage7Codegen(opts: PipelineRunOptions): Promise<{
    readonly created: readonly string[];
    readonly updated: readonly string[];
  }> {
    // Surface emitter-uniqueness conflicts up-front so the error names both
    // origins before we burn cycles on emission.
    await this.emitters.validateUniqueness();

    let files: readonly EmittedFile[];
    try {
      const runnerOpts: {strict?: boolean} = {};
      if (opts.strict === true) runnerOpts.strict = true;
      // Apply per-run schema overrides (currently the CLI ↔ engine
      // `--emit-graphql-sdl` handshake on `config['graphql-overrides']`)
      // BEFORE handing the schema set to the runner. The runner extracts
      // `x-<kind>` per-schema options in `buildContext`, so the override
      // must already live on the schema by the time it arrives. See
      // `applyGraphqlSdlOverride` for the merge semantics.
      const schemasForEmit = this.applyGraphqlSdlOverride(
        this.registry.list(),
        opts.config,
      );
      files = await this.runner.run(schemasForEmit, opts.emitFlags, runnerOpts);
    } catch (err) {
      if (err instanceof ContractsCodegenError) throw err;
      throw new ContractsCodegenError(
        `stage 7 (codegen) failed: ${(err as Error).message}`,
        {emitterKind: '<unknown>', schemaId: '<unknown>'},
        {cause: err},
      );
    }

    // Stage 7c.5 — engine-owned module-format normalisation. Runs BEFORE
    // the FileWriter so header banner / hashing / collision / write-policy
    // act on the final bytes. ESM mode rewrites relative imports/exports,
    // narrows type-only imports, and rejects CJS syntax. Default mode is
    // pass-through. See contracts-extensibility.md §"Module-format choice".
    const transformedFiles = applyModuleFormat(files, opts.moduleFormat);

    // Stage 7c.6 — per-directory barrels. README §"Generated layout"
    // promises one `index.ts` per generated LB4-idiom directory
    // (`models`, `repositories`, `controllers`, `datasources`) so
    // downstream code can `import {X} from '../models'` without naming
    // the specific file. `buildBarrels` is a pure projection over
    // `transformedFiles` — module-format normalisation has already run,
    // so the barrel sees the final extensions and doesn't need a second
    // pass through {@link ModuleFormatTransformer}. Returns `[]` for
    // projects with no LB4-idiom output (e.g. sidecar-only runs), so
    // existing zero-output projects are unaffected.
    const barrelFiles = this.buildBarrels(transformedFiles);

    // Stage 7d — the single atomic commit point. Emitter output is
    // rooted at `paths.outputDir`; queued meta-schemas (which live at
    // `paths.root/_meta`) anchor at `paths.root` via the per-file root
    // override map. Both batches go through one `writeAll` call so the
    // phase-1/phase-2 split spans every file in the run — a failure
    // either rolls back everything (phase 1) or leaves a rare,
    // well-described partial state (phase 2) covering both roots,
    // preserving the no-partial-writes guarantee across the two anchors.
    //
    // The `models/` bucket is relocated to `paths.modelsDir` (the
    // `outputDir` config key / `--out-dir` flag) first; the barrel above
    // already saw the logical `models/` paths.
    const placed = placeModelOutputs(
      [...transformedFiles, ...barrelFiles],
      this.paths,
    );
    const allFiles: readonly EmittedFile[] = [
      ...placed.files,
      ...this.writeQueue,
    ];
    const perFileRoots = new Map<string, string>(placed.perFileRoots);
    for (const meta of this.writeQueue) {
      perFileRoots.set(meta.path, this.paths.root);
    }
    const written = await this.writer.writeAll(
      this.paths.outputDir,
      allFiles,
      perFileRoots,
    );

    return {created: written.created, updated: written.updated};
  }

  /**
   * Apply the CLI ↔ engine `--emit-graphql-sdl` handshake to every
   * schema before the runner extracts its per-schema `x-graphql` block.
   *
   * The CLI flag (`gen.ts:applyPerSchemaOverrides`) sets a sibling
   * `'graphql-overrides': {sdl: true}` key on the config. The
   * `GraphQLEmitter` reads its `sdl` toggle from a schema's `x-graphql`
   * block at emit time, so a sibling config key never reached the
   * emitter — the documented flag was silently a no-op. This step
   * forwards the override by shallow-copying every schema that has (or
   * could opt into) GraphQL emission and merging `sdl: true` into its
   * `x-graphql` block.
   *
   * Returns the input array unchanged when the override is not set,
   * which keeps the no-op path zero-cost. When set, returns a fresh
   * array of shallow-copied schemas so the originals (and the
   * registry) stay untouched — `EmitterRunner.buildContext` shallow-
   * freezes whatever schema it receives.
   */
  private applyGraphqlSdlOverride(
    schemas: readonly JSONSchema[],
    config: LoopbackConfigJson,
  ): readonly JSONSchema[] {
    const overrides = (
      config as LoopbackConfigJson & {
        readonly 'graphql-overrides'?: {readonly sdl?: boolean};
      }
    )['graphql-overrides'];
    if (overrides?.sdl !== true) return schemas;
    return schemas.map(schema => {
      const existing = schema['x-graphql'];
      const existingBlock = isPlainObject(existing) ? existing : {};
      const mergedBlock = {...existingBlock, sdl: true};
      const copy: JSONSchema = {...schema, 'x-graphql': mergedBlock};
      return copy;
    });
  }

  /**
   * Group emitted files by their immediate parent directory and produce
   * one `index.ts` barrel per directory via {@link BarrelGenerator}.
   * Only the four LB4-idiom roots (`models`, `repositories`,
   * `controllers`, `datasources`) get barrels — sidecar emitter output
   * (`zod`, `types`, `graphql`, ...) lives under its own per-kind tree
   * and is not part of the README-documented barrel surface.
   *
   * `.base.<kind>.ts` files are the source of re-exports; `.<kind>.ts`
   * extension files are NOT internal (they're the user-editable
   * counterpart), so the `hasExtension` predicate reports `true` when
   * the engine just emitted (or the project already shipped) the
   * matching extension stub — the barrel then re-exports BOTH so a
   * downstream `import {X} from '../models'` resolves whether `X` is
   * owned by the base or the extension.
   *
   * Returns `[]` when no LB4-idiom files were emitted, preserving the
   * existing zero-output projects.
   */
  private buildBarrels(files: readonly EmittedFile[]): readonly EmittedFile[] {
    type BarrelDir = 'models' | 'repositories' | 'controllers' | 'datasources';
    type BarrelKind = 'model' | 'repository' | 'controller' | 'datasource';
    const dirKinds: Readonly<Record<BarrelDir, BarrelKind>> = {
      models: 'model',
      repositories: 'repository',
      controllers: 'controller',
      datasources: 'datasource',
    };
    // Per-directory name set (kebab basenames stripped of `.base.<kind>`)
    // plus a per-(dir,name) flag for whether an extension stub was emitted
    // alongside the base in this run. The flag drives the
    // `hasExtension` callback `BarrelGenerator.generate` accepts, so the
    // engine itself does no filesystem I/O — keeps the helper pure.
    const names: Record<BarrelDir, Set<string>> = {
      models: new Set(),
      repositories: new Set(),
      controllers: new Set(),
      datasources: new Set(),
    };
    const extensions: Record<BarrelDir, Set<string>> = {
      models: new Set(),
      repositories: new Set(),
      controllers: new Set(),
      datasources: new Set(),
    };
    for (const file of files) {
      const slash = file.path.indexOf('/');
      if (slash < 0) continue;
      const dir = file.path.slice(0, slash) as BarrelDir;
      if (!(dir in dirKinds)) continue;
      const kind = dirKinds[dir];
      const basename = file.path.slice(slash + 1);
      if (!basename.endsWith('.ts')) continue;
      const stem = basename.slice(0, -'.ts'.length);
      const baseSuffix = `.base.${kind}`;
      const extSuffix = `.${kind}`;
      if (stem.endsWith(baseSuffix)) {
        names[dir].add(stem.slice(0, -baseSuffix.length));
      } else if (stem.endsWith(extSuffix)) {
        extensions[dir].add(stem.slice(0, -extSuffix.length));
      }
    }
    const hasExt = (name: string, kind: BarrelKind): boolean => {
      // Reverse-lookup the dir from the kind — only one dir per kind, so
      // the map collapses to a single entry.
      for (const [dir, k] of Object.entries(dirKinds) as readonly [
        BarrelDir,
        BarrelKind,
      ][]) {
        if (k === kind) return extensions[dir].has(name);
      }
      return false;
    };
    return this.barrels.generate({
      models: [...names.models],
      repositories: [...names.repositories],
      controllers: [...names.controllers],
      datasources: [...names.datasources],
      hasExtension: hasExt,
    });
  }

  /**
   * Apply every {@link MetaSchemaContributor} whose `target` matches the
   * named meta-schema to the supplied document, chaining contributors in
   * LB4 binding-registration order. Each contributor receives the
   * previous output; the contract forbids in-place mutation, so the
   * helper just threads the returned object through the chain.
   *
   * Defensive on three axes:
   *   - Empty contributor list -\> returns `current` unchanged (no-op).
   *   - A contributor that returns a non-object (or `null`) is rejected
   *     with a typed {@link ContractsValidationError} naming the plugin's
   *     constructor so the offending contribution is identifiable.
   *   - A contributor that throws is wrapped in
   *     {@link ContractsValidationError} carrying the same identifier,
   *     so an opaque "TypeError: x is undefined" surfaces as a stage-5
   *     plugin failure with provenance instead of a bare stack trace.
   *
   * The returned schema is what the caller queues to disk AND compiles
   * into the runtime Ajv validator — the on-disk meta-schema and the
   * stage-5 validator therefore stay byte-equivalent.
   */
  private applyMetaSchemaContributors(
    target: string,
    current: JSONSchema,
    contributors: readonly MetaSchemaContributor[],
  ): JSONSchema {
    if (contributors.length === 0) return current;
    let acc = current;
    for (const contributor of contributors) {
      if (contributor.target !== target) continue;
      let next: unknown;
      try {
        next = contributor.contribute(acc);
      } catch (cause) {
        throw new ContractsValidationError(
          `stage 5: meta-schema contributor '${contributorLabel(contributor)}' ` +
            `threw while augmenting '${target}': ${(cause as Error).message}`,
          {sourcePath: target, instancePath: ''},
          {cause},
        );
      }
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        throw new ContractsValidationError(
          `stage 5: meta-schema contributor '${contributorLabel(contributor)}' ` +
            `returned a non-object for '${target}' ` +
            `(got ${next === null ? 'null' : Array.isArray(next) ? 'array' : typeof next}); ` +
            'contributors must return a JSON Schema object',
          {sourcePath: target, instancePath: ''},
        );
      }
      acc = next as JSONSchema;
    }
    return acc;
  }

  /**
   * Invoke every {@link ContractsValidator} registered under
   * {@link ContractsBindings.VALIDATOR_TAG} whose `stage` matches
   * `stage`. Empty validator set is a no-op. A validator that returns
   * `ok: false` aborts the pipeline with a typed error naming the
   * plugin; a validator that throws is wrapped with the same provenance.
   *
   * `'pre'` validators surface as {@link ContractsValidationError}
   * (codegen has not yet started, so the failure is a validation gate).
   * `'post'` validators surface as {@link ContractsCodegenError} — files
   * have already been written and the failure attribution is the
   * codegen artefact, not an authored input. Unknown/custom stage
   * strings follow the same `'post'` mapping per the interface's
   * "treated as `'post'` for forward compatibility" clause.
   *
   * Issues with `severity: 'info'` or `severity: 'warn'` (when
   * `ok: true`) are forwarded to the lossy reporter and never abort.
   */
  private async runValidators(
    stage: 'pre' | 'post',
    opts: PipelineRunOptions,
  ): Promise<void> {
    const validators = await this.validatorsView.values();
    if (validators.length === 0) return;
    // The validator interface requires a `ReadonlyMap<string, JSONSchema>`
    // keyed by `$id`; the registry exposes a list snapshot, so we
    // materialise the map here. Schemas missing an `$id` cannot land in
    // the registry by construction (stage 2 rejects them), so the
    // `typeof === 'string'` guard is defensive belt-and-braces.
    const schemaMap = new Map<string, JSONSchema>();
    for (const schema of this.registry.list()) {
      const id = (schema as {$id?: unknown}).$id;
      if (typeof id === 'string' && id.length > 0) schemaMap.set(id, schema);
    }
    const context: ValidatorContext = {
      paths: this.paths,
      schemas: schemaMap,
      strict: opts.strict === true,
    };
    for (const validator of validators) {
      const validatorStage =
        validator.stage === 'pre' ? 'pre' : ('post' as const);
      if (validatorStage !== stage) continue;
      let result;
      try {
        result = await validator.validate(context);
      } catch (cause) {
        throw wrapValidatorError(stage, validator, cause);
      }
      // Forward non-fatal issues so the CLI's lossy report surfaces
      // them. `ok: false` issues are folded into the thrown error
      // message below; `ok: true` issues are pure advisory.
      if (result.ok && result.issues !== undefined) {
        for (const issue of result.issues) {
          if (issue.severity === 'info' || issue.severity === 'warn') {
            const source: {schemaId: string; instancePath?: string} = {
              schemaId: issue.schemaId ?? '',
            };
            if (issue.instancePath !== undefined) {
              source.instancePath = issue.instancePath;
            }
            this.lossy.report({
              feature: `validator/${contributorLabel(validator)}`,
              source,
              severity: issue.severity,
              message: issue.message,
            });
          }
        }
      }
      if (!result.ok) {
        const summary = formatValidatorIssues(result.issues);
        const label = contributorLabel(validator);
        if (stage === 'pre') {
          throw new ContractsValidationError(
            `stage 5+: validator '${label}' rejected the run:\n${summary}`,
            {sourcePath: this.paths.root, instancePath: ''},
          );
        }
        throw new ContractsCodegenError(
          `stage 7+: post-codegen validator '${label}' rejected the run:\n${summary}`,
          {emitterKind: `validator/${label}`, schemaId: '<all>'},
        );
      }
    }
  }

  /**
   * Push one meta-schema document into the deferred write queue (flushed
   * in stage 7d). Path is relative to `paths.root`; the canonical
   * `_meta/<name>` location is preserved.
   */
  private queueMetaSchema(fileName: string, schema: object): void {
    this.writeQueue.push({
      path: join('_meta', fileName),
      content: JSON.stringify(schema, null, 2) + '\n',
      encoding: 'utf-8',
      policy: 'regen',
      producer: 'pipeline/meta',
    });
  }

  // ----- Stage 8 -------------------------------------------------------

  private async stage8Tsc(opts: PipelineRunOptions): Promise<boolean> {
    // Two opt-out paths, OR'd: the CLI `--skip-tsc` flag (transient,
    // per-invocation) AND the `security.codegen.runTsc` config field
    // (persistent, per-project). `runTsc === false` is the explicit
    // opt-out; an absent or `true` value keeps the default behaviour
    // (run the gate) so existing configs without a `security` block see
    // no change. Logged at info level so a CI run grep'ing for the line
    // can confirm the gate was deliberately bypassed.
    const runTscOptIn = opts.config.security?.codegen?.runTsc;
    if (runTscOptIn === false) {
      debug('stage 8: tsc skipped — security.codegen.runTsc = false');
      return true;
    }
    if (opts.skipTsc) return true;
    const tsconfig = join(opts.projectRoot, 'tsconfig.json');
    if (!existsSync(tsconfig)) {
      // No project tsconfig — nothing to gate against; treat as success.
      return true;
    }
    try {
      // `execFile` with an argv array — no shell, no metacharacter
      // interpretation, no injection surface for a hostile project root
      // or tsconfig path. Cross-platform note: on Windows the `npx`
      // shim is `npx.cmd`; spawning `.cmd` files via `execFile` without
      // a shell can fail, but the contracts engine targets POSIX hosts
      // for codegen and that's the documented runtime.
      await execFileAsync(
        'npx',
        ['--no-install', 'tsc', '--noEmit', '-p', tsconfig],
        {
          cwd: opts.projectRoot,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      return true;
    } catch (err) {
      const e = err as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
      };
      const out = (e.stdout ?? '') + (e.stderr ?? '');
      throw new ContractsCodegenError(
        `stage 8: \`tsc --noEmit\` reported errors:\n${out.trim()}`,
        {emitterKind: 'tsc', schemaId: '<all>'},
        {cause: err},
      );
    }
  }
}

// ----- helpers (module-private) ----------------------------------------

interface FetchedFile {
  readonly sourcePath: string;
  readonly descriptor: string;
  readonly content: string;
}

interface ParsedSchema {
  readonly sourcePath: string;
  readonly descriptor: string;
  readonly schema: JSONSchema;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Best-effort identifier for a plugin-contributed object used purely for
 * error-message provenance ("which plugin's contributor blew up?").
 * Falls back to `'<anonymous>'` for objects constructed via an anonymous
 * class expression — same policy {@link EmitterRegistry}'s
 * `originLabel` follows.
 */
function contributorLabel(target: unknown): string {
  const ctor = (target as {constructor?: {name?: string}}).constructor;
  const name = ctor?.name;
  return name && name.length > 0 ? name : '<anonymous>';
}

/**
 * Wrap an exception thrown by a {@link ContractsValidator} in the right
 * pipeline-scoped error class. `'pre'` validators surface as
 * `ContractsValidationError` (no files written yet); `'post'` validators
 * surface as `ContractsCodegenError` (post-emit failure).
 */
function wrapValidatorError(
  stage: 'pre' | 'post',
  validator: ContractsValidator,
  cause: unknown,
): ContractsValidationError | ContractsCodegenError {
  const label = contributorLabel(validator);
  const message = (cause as Error).message;
  if (stage === 'pre') {
    return new ContractsValidationError(
      `stage 5+: validator '${label}' threw: ${message}`,
      {sourcePath: '<validator>', instancePath: ''},
      {cause},
    );
  }
  return new ContractsCodegenError(
    `stage 7+: post-codegen validator '${label}' threw: ${message}`,
    {emitterKind: `validator/${label}`, schemaId: '<all>'},
    {cause},
  );
}

/**
 * Format a {@link ValidationResult}'s `issues` array into a multi-line
 * block — one line per issue, mirroring {@link formatAjvErrors}'s shape
 * so the CLI's error renderer surfaces both in the same indentation.
 */
function formatValidatorIssues(
  issues:
    | ReadonlyArray<{
        readonly severity: 'info' | 'warn' | 'error';
        readonly message: string;
        readonly schemaId?: string;
        readonly instancePath?: string;
      }>
    | undefined,
): string {
  if (!issues || issues.length === 0) return '  (no issue details)';
  return issues
    .map(i => {
      const path = i.instancePath ?? '<root>';
      const id = i.schemaId !== undefined ? ` [${i.schemaId}]` : '';
      return `  - ${path}${id} ${i.message} [severity=${i.severity}]`;
    })
    .join('\n');
}

/**
 * Reject a {@link ModelConfigJson} whose `dataSource` field names a
 * datasource that isn't declared in `datasources.json`. Without this
 * cross-check, a config like `{dataSource: 'primary'}` against an empty
 * `datasources.json` (or a typo like `'primry'`) would pass stage 5 —
 * the meta-schema only emits a `dataSource` enum when the loaded
 * datasource list is non-empty (see `buildModelConfigMetaSchema()` in
 * `meta-schema-generator.ts`), so missing/typo'd references silently
 * slip through. The user only finds out at stage 8 when `tsc` blows up
 * on a non-existent `../datasources/<name>.base.datasource` import the
 * repository generator emitted — a confusing failure mode pointing at
 * generated code instead of the actual config error.
 *
 * Throws a typed {@link ContractsValidationError} naming the missing
 * datasource and the available alternatives, plus a hint on how to add
 * one. `sourcePath` mirrors the disk-vs-inline error shape the rest of
 * stage 5 uses; pass the inline-bindings index as `bindingIndex` to
 * stamp the right `instancePath`.
 */
function assertDatasourceDeclared(
  config: ModelConfigJson,
  datasources: readonly DatasourceConfigJson[],
  sourcePath: string,
  bindingIndex?: number,
): void {
  const declared = new Set(datasources.map(d => d.name));
  if (declared.has(config.dataSource)) return;
  const available =
    declared.size === 0
      ? '(no datasources declared)'
      : [...declared].sort().join(', ');
  const hint =
    declared.size === 0
      ? 'Create `datasources.json` at the project root and add an entry for ' +
        `'${config.dataSource}' (e.g. \`lb-contracts ds ${config.dataSource} --adapter <kind>\`).`
      : `Available: ${available}. Add '${config.dataSource}' to ` +
        '`datasources.json` or correct the typo.';
  const instancePath =
    bindingIndex !== undefined
      ? `/config-bindings/${bindingIndex}/dataSource`
      : '/dataSource';
  throw new ContractsValidationError(
    `stage 5: config '${config.$contractId}' references datasource ` +
      `'${config.dataSource}' which is not declared in datasources.json.\n` +
      `  ${hint}`,
    {
      sourcePath,
      instancePath,
      schemaId: config.$contractId,
    },
  );
}

/**
 * Format an Ajv error array into a stable multi-line block.
 * `allErrors: true` collects every failure; one line per error keeps multi-failure
 * output scannable. Each line has the form:
 *
 *   - <instancePath> <message> [keyword=<kw>]
 *
 * Per RFC 6901 §5 the JSON Pointer for the document root is the empty
 * string (not `/`, which points at the property keyed by the empty
 * string). To keep the line prefix scannable while still being
 * technically correct, an empty `instancePath` is rendered as the
 * literal placeholder `<root>` — distinct from any real RFC-6901 pointer
 * and unambiguous to a human reader.
 */
function formatAjvErrors(errors: ErrorObject[] | null | undefined): string {
  if (!errors || errors.length === 0) return '  (no error details)';
  return errors
    .map(e => {
      const path = e.instancePath.length === 0 ? '<root>' : e.instancePath;
      // Ajv's default `message` for `additionalProperties: false` is
      // 'must NOT have additional properties' — which doesn't name the
      // offending key. The rejected key sits on `params.additionalProperty`;
      // appending it makes the typo immediately actionable (the diff
      // between `zod` and `zodd` is otherwise invisible from the message).
      // Mirror for `enum` violations, which Ajv reports without echoing
      // the offending value.
      const params = (e.params ?? {}) as Record<string, unknown>;
      let suffix = '';
      if (
        e.keyword === 'additionalProperties' &&
        typeof params['additionalProperty'] === 'string'
      ) {
        suffix = ` (unknown key: '${params['additionalProperty']}')`;
      } else if (
        e.keyword === 'enum' &&
        Array.isArray(params['allowedValues'])
      ) {
        // Cap rendering at 8 entries so a future object-typed enum
        // (or just an unusually large string enum) can't balloon the
        // diagnostic block past readability. Short-circuit objects
        // / arrays to a `[object]` placeholder for the same reason —
        // today every meta-schema enum is `string[]`, but the
        // formatter shouldn't assume that forever.
        const allowed = params['allowedValues'] as readonly unknown[];
        const head = allowed.slice(0, 8);
        const rendered = head
          .map(v =>
            typeof v === 'object' && v !== null
              ? '[object]'
              : JSON.stringify(v),
          )
          .join(', ');
        const tail =
          allowed.length > 8 ? `, …(+${allowed.length - 8} more)` : '';
        suffix = ` (allowed: ${rendered}${tail})`;
      }
      return `  - ${path} ${e.message ?? ''}${suffix} [keyword=${e.keyword}]`;
    })
    .join('\n');
}

/**
 * Load `<projectRoot>/datasources.json` and return a flat
 * `DatasourceConfigJson[]` regardless of which on-disk layout the project
 * uses. Two layouts are accepted, in lock-step with
 * `normaliseDatasources()` in `src/generators/datasource-generator.ts`:
 *
 *   - Array form: `[{"name": "primary", "adapter": "mongodb", ...}, ...]`
 *   - Keyed-map form: `{"primary": {"adapter": "mongodb", ...}, ...}` —
 *     preferred shape (`lb-contracts ds` writes this). The optional `$schema`
 *     key is skipped. Each entry is normalised by folding the map key
 *     in as the entry's `name` field so the returned array shape is
 *     uniform across both layouts.
 *
 * Missing `datasources.json` returns `[]`. Malformed JSONC (parse
 * errors, non-object/non-array top level) throws
 * {@link ContractsValidationError} via the shared
 * {@link readDatasourcesDoc} helper — same diagnostic block the
 * `lb-contracts ds` and `lb-contracts contract` surfaces emit, so
 * users see one error message regardless of which command tripped the
 * file first. A malformed entry inside an otherwise-valid document
 * (non-object value, string value other than `$schema`) still surfaces
 * later via stage 5's meta-schema validation.
 *
 * Sync vs async: the shared helper is sync (`readFileSync`). The
 * per-run cost is a single file read off the hot loop, so the sync
 * call is intentional — wrapping it in a thenable would only add noise.
 * {@link loadRawDatasources} keeps its `async` signature so the two
 * `await` call-sites in {@link Pipeline.stage5ValidateConfigs} stay
 * unchanged.
 */
async function loadDatasources(
  projectRoot: string,
): Promise<DatasourceConfigJson[]> {
  const raw = await loadRawDatasources(projectRoot);
  if (raw === undefined) return [];
  const parsed = parseDatasourcesJson(raw.raw, raw.path);
  assertNoDuplicateDatasourceNames(parsed, raw.path);
  return parsed;
}

/**
 * Read and parse `<projectRoot>/datasources.json` and return the RAW
 * top-level JSON value alongside the absolute path. Returns `undefined`
 * when the file does not exist (ENOENT remains benign — a contracts-only
 * project legitimately ships no datasources).
 *
 * Kept separate from {@link loadDatasources} so stage 5 can validate the
 * raw shape against {@link buildDatasourcesMetaSchema} BEFORE
 * {@link parseDatasourcesJson} folds the keyed-map layout into the flat
 * array form. Without this split, the meta-schema's `oneOf` (array vs
 * keyed-map) would never see the keyed-map branch.
 *
 * Delegates the read + parse to the shared {@link readDatasourcesDoc}
 * helper so the pipeline, `lb-contracts ds`, and `lb-contracts contract`
 * all surface byte-identical diagnostics for a malformed
 * `datasources.json` (JSONC-aware parser, line:column pointer, typed
 * {@link ContractsValidationError}). Prior to this delegation the
 * pipeline used `JSON.parse` and rejected trailing commas / `//`
 * comments that the CLI surfaces happily accept — same input, two
 * verdicts, depending on which command ran first.
 *
 * The helper is synchronous (`readFileSync`); see the rationale on
 * {@link loadDatasources}. This function keeps its `async` signature
 * so the two `await` call-sites stay unchanged.
 */
async function loadRawDatasources(
  projectRoot: string,
): Promise<{readonly raw: unknown; readonly path: string} | undefined> {
  const path = resolve(projectRoot, 'datasources.json');
  const raw = readDatasourcesDoc(path);
  if (raw === undefined) return undefined;
  return {raw, path};
}

/**
 * Best-effort scan of `<projectRoot>/package.json` for installed
 * `loopback-connector-*` peers. Returns the suffixes of every match
 * across `dependencies`, `devDependencies`, and `peerDependencies` so
 * the datasources meta-schema can constrain `adapter` to the project's
 * actual connector set — the README documents the enum as
 * "project-specific from installed connector peers".
 *
 * Both LB4 naming conventions are accepted: the legacy unscoped
 * `loopback-connector-<name>` form AND the official scoped
 * `@loopback/connector-<name>` form (which is what stock LB4 projects
 * pull in). Suffix captures from BOTH patterns are unioned into the
 * same `Set` so an adapter installed under either name surfaces in the
 * enum exactly once.
 *
 * Custom-scoped connectors (e.g. `@my-org/loopback-connector-*`) are
 * intentionally out of scope — they don't follow the canonical LB4
 * naming convention this discovery walks. Authors using custom scopes
 * must hand-extend `_meta/datasources.schema.json` or pass
 * `installedAdapters` directly to the meta-schema builder.
 *
 * Silent on every failure mode (missing file, unreadable file, malformed
 * JSON, non-object root) — adapter-enum hinting is an authoring nicety,
 * not a validation gate, so a broken `package.json` should never abort
 * a `lb-contracts gen` run that would otherwise succeed.
 *
 * @internal
 */
export async function discoverInstalledAdapters(
  projectRoot: string,
): Promise<readonly string[]> {
  const path = resolve(projectRoot, 'package.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isPlainObject(pkg)) return [];
  const sections: readonly string[] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
  ];
  const out = new Set<string>();
  const patterns: readonly RegExp[] = [
    /^loopback-connector-(.+)$/,
    /^@loopback\/connector-(.+)$/,
  ];
  for (const section of sections) {
    const entries = (pkg as Record<string, unknown>)[section];
    if (!isPlainObject(entries)) continue;
    for (const name of Object.keys(entries)) {
      for (const pattern of patterns) {
        const match = pattern.exec(name);
        if (match && match[1] !== undefined && match[1].length > 0) {
          out.add(match[1]);
        }
      }
    }
  }
  return [...out].sort();
}

/**
 * Normalise the parsed `datasources.json` document into a flat
 * {@link DatasourceConfigJson}[]. Two on-disk layouts are accepted:
 *
 *   - Array form: each element must be an object with a `name` field
 *     that's a non-empty string.
 *   - Keyed-map form: each key (other than `$schema`) becomes the
 *     entry's canonical `name`. The map key WINS over any `name` field
 *     declared inside the value — same precedence as
 *     `normaliseDatasources()` in the generator. Empty / whitespace-only
 *     keys are rejected to avoid emitting a `.base.datasource.ts` file
 *     with an empty / `.base.datasource.ts` filename.
 *
 * Malformed entries (non-object array members, string values in the
 * keyed-map, empty names) are rejected with a typed error rather than
 * silently dropped, so the user gets a clear stage-5 diagnostic instead
 * of a downstream "datasource not declared" surprise.
 */
function parseDatasourcesJson(
  json: unknown,
  path: string,
): DatasourceConfigJson[] {
  if (Array.isArray(json)) {
    const out: DatasourceConfigJson[] = [];
    for (const [i, entry] of (json as readonly unknown[]).entries()) {
      if (entry === null || typeof entry !== 'object') {
        throw new ContractsValidationError(
          `stage 5: datasources.json[${i}] is not an object`,
          {sourcePath: path, instancePath: `/${i}`},
        );
      }
      const name = (entry as {name?: unknown}).name;
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new ContractsValidationError(
          `stage 5: datasources.json[${i}] missing required string field 'name'`,
          {sourcePath: path, instancePath: `/${i}/name`},
        );
      }
      out.push(entry as DatasourceConfigJson);
    }
    return out;
  }
  if (json !== null && typeof json === 'object') {
    const out: DatasourceConfigJson[] = [];
    for (const [name, value] of Object.entries(
      json as Record<string, unknown>,
    )) {
      if (name === '$schema') continue;
      if (name.trim().length === 0) {
        throw new ContractsValidationError(
          'stage 5: datasources.json keyed-map contains an empty key',
          {sourcePath: path, instancePath: ''},
        );
      }
      if (value === null || typeof value !== 'object') {
        throw new ContractsValidationError(
          `stage 5: datasources.json['${name}'] is not an object`,
          {sourcePath: path, instancePath: `/${name}`},
        );
      }
      // Fold the map key in as the canonical `name`. If the entry
      // already declares a different `name`, the map key wins — same
      // precedence `normaliseDatasources()` applies in the generator,
      // so the engine's view stays in lock-step.
      out.push({
        ...(value as DatasourceConfigJson),
        name,
      });
    }
    return out;
  }
  // Valid JSON but not an array or object — a string / number / null
  // at the top level is a structural error worth surfacing rather than
  // silently returning [].
  throw new ContractsValidationError(
    `stage 5: datasources.json must be a JSON array or object (got ${typeof json})`,
    {sourcePath: path, instancePath: ''},
  );
}

/**
 * Reject a `datasources.json` set that declares the same `name` twice.
 * Without this check, a duplicate would silently dedupe via the
 * cross-validation `Set` and the generator would deterministically
 * pick the last entry — pointing every `dataSource: '<name>'`
 * reference at the wrong adapter with no diagnostic.
 */
function assertNoDuplicateDatasourceNames(
  datasources: readonly DatasourceConfigJson[],
  path: string,
): void {
  const seen = new Set<string>();
  for (const ds of datasources) {
    if (seen.has(ds.name)) {
      throw new ContractsValidationError(
        `stage 5: datasources.json declares duplicate datasource name ` +
          `'${ds.name}'. Each datasource name must be unique.`,
        {sourcePath: path, instancePath: ''},
      );
    }
    seen.add(ds.name);
  }
}

async function listConfigFiles(configsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(configsDir, {withFileTypes: true});
    return entries
      .filter(e => e.isFile() && e.name.endsWith('.config.json'))
      .map(e => join(configsDir, e.name));
  } catch {
    return [];
  }
}

/**
 * Apply the engine-owned module-format transform to emitter output.
 *
 * Returns the input slice unchanged when ESM mode is off (the default),
 * which keeps the no-op path zero-cost — `ts-morph` is never required.
 * When `esm: true`, constructs a single {@link ModuleFormatTransformer}
 * per run (it's cheap to allocate; the project doesn't share state
 * between runs).
 *
 * @internal
 */
function applyModuleFormat(
  files: readonly EmittedFile[],
  moduleFormat: PipelineRunOptions['moduleFormat'],
): readonly EmittedFile[] {
  const esm = moduleFormat?.esm === true;
  if (!esm) return files;
  const importExtension = moduleFormat?.importExtension ?? '.js';
  const transformer = new ModuleFormatTransformer({esm: true, importExtension});
  return transformer.transform(files);
}
