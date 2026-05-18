import {BindingScope, inject, injectable} from '@loopback/core';
import {execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdir, open, readdir, readFile, rename, unlink} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {promisify} from 'node:util';
import Ajv2020 from 'ajv/dist/2020';
import type {ErrorObject, ValidateFunction} from 'ajv';
import createDebug from 'debug';

import {
  ContractsCodegenError,
  ContractsPipelineError,
  ContractsSourceError,
  ContractsValidationError,
} from '../helpers';
import type {
  EmittedFile,
  JSONSchema,
  LossyReport,
  ProjectPaths,
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
import {SourceResolverRegistry} from './source-resolver-registry';
import {ContractsEngineBindings} from './tokens';

const execFileAsync = promisify(execFile);
const debug = createDebug('loopback:contracts:pipeline');

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
  /** Override the stage-6 breaking-change refusal. */
  readonly allowBreaking?: boolean;
  /** Skip the stage-8 `tsc --noEmit` gate (for `--dry-run`). */
  readonly skipTsc?: boolean;
  /**
   * Stop after the validation chain (stages 1-6) and skip stages 7-8 plus
   * the diff-state cache write. The returned {@link PipelineResult} has
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

/** Cache file written under `.loopback/cache/diff-state.json`. */
interface DiffStateCache {
  readonly version: 1;
  /** Keyed by `<descriptor-uri>@<schema-$id>`. */
  readonly entries: Record<string, DiffStateEntry>;
}

/** One cached snapshot used by stage 6 to compute backward-compat diffs. */
interface DiffStateEntry {
  readonly descriptor: string;
  readonly schemaId: string;
  /**
   * The opaque pin extracted from the descriptor (e.g., `#v1.2.0`,
   * `?ref=sha`, the package version). Empty string for an unpinned
   * descriptor.
   */
  readonly pin: string;
  /** Canonical JSON of the schema at the time it was cached. */
  readonly schemaJson: string;
}

/** Stage-6 classification verdict. */
type DiffClassification = 'additive' | 'narrowing' | 'breaking' | 'unchanged';

/**
 * Eight-stage validation + codegen pipeline. Owned by the engine; invoked
 * once per `lb4 gen` call.
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
   * Per-run map of `schema $id` -\> the originating descriptor (the entry
   * from `loopback.config.json.schemas[]` that produced it). Populated in
   * stage 2 after the schema has been validated and its `$id` extracted,
   * and consumed in stage 6 so the diff iterates `N` schemas instead of
   * the `N × M` Cartesian over every descriptor. Reset at the top of every
   * {@link run} call. Cached and queried by schemaId; a second descriptor
   * producing the same `$id` overrides (stage 3's dedupe already enforces
   * content-equality so the descriptor choice is informational only).
   */
  private readonly schemaOrigins = new Map<string, string>();

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
    this.schemaOrigins.clear();
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

    const nextDiffState = await this.stage6DiffBreakingChanges(opts);
    stagesRun = 6;
    if (maxStage <= 6) return this.summarise(stagesRun);

    // `--validate-only` short-circuits before codegen and before any cache
    // write so the command remains read-only.
    if (opts.validateOnly === true) return this.summarise(stagesRun);

    const writeResult = await this.stage7Codegen(opts);
    stagesRun = 7;

    // Persist the updated diff-state cache only after codegen wrote files
    // — a failed stage 7 must not advance the baseline. Wrapped in its
    // own try/catch: a cache write hiccup (full disk, permission flip)
    // must not surface as a stage-7 codegen error, since the source-of-
    // truth artefacts have already landed successfully.
    try {
      await this.persistDiffStateCache(opts, nextDiffState);
    } catch (err) {
      // `source.schemaId` is an empty string because the failure is not
      // attributable to any single schema — the diff-state cache is a
      // pipeline-level artefact. The message names the affected
      // subsystem so the report is still scannable.
      this.lossy.report({
        feature: 'diff-state-cache',
        source: {schemaId: ''},
        severity: 'warn',
        message:
          `diff-state-cache: failed to persist baseline ` +
          `(${(err as Error).message}); next run will re-diff every ` +
          `schema as if no baseline existed`,
      });
    }

    if (maxStage <= 7) {
      return {
        filesWritten: [...writeResult.created, ...writeResult.updated],
        lossy: this.lossy.entries(),
        tscOk: true,
        stagesRun,
      };
    }

    const tscOk = await this.stage8Tsc(opts);
    stagesRun = 8;

    return {
      filesWritten: [...writeResult.created, ...writeResult.updated],
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
      // Record the schemaId -> descriptor mapping so stage 6 can diff
      // each schema against its own descriptor instead of every
      // descriptor in the project. The descriptor is `file.descriptor`
      // — the original `loopback.config.json.schemas[]` entry — not the
      // `sourcePath`, which embeds the file-relative path inside that
      // source.
      this.schemaOrigins.set(schemaId, file.descriptor);
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
      this.walkResolveRefs(schema, rootId, rootId);
    }
  }

  /**
   * Walk a schema resolving every `$ref` against the current base URI per
   * RFC 3986 §5.3 — JSON Schema 2020-12 §8.2.1.7 makes `$id` the base for
   * its enclosing subschema, so we update the base when descending into a
   * subschema that declares its own `$id`.
   *
   * `json-schema-traverse` exposes `jsonPtr` but not base-URI state, so we
   * recurse ourselves over the standard 2020-12 keyword set. Remote
   * `http(s)://` refs that don't resolve to a loaded schema still error —
   * fetching remote refs is out of scope for v1.0.
   */
  private walkResolveRefs(
    node: unknown,
    baseUri: string,
    rootId: string,
  ): void {
    if (Array.isArray(node)) {
      for (const item of node) this.walkResolveRefs(item, baseUri, rootId);
      return;
    }
    if (!isPlainObject(node)) return;

    // Per RFC 3986 §5.3 — entering a subschema with its own `$id` rebases
    // every relative `$ref` beneath it. Absolute `$id` replaces baseUri;
    // relative `$id` resolves against the current base.
    let currentBase = baseUri;
    const subId = node['$id'];
    if (typeof subId === 'string' && subId.length > 0) {
      try {
        currentBase = new URL(subId, baseUri).href;
      } catch {
        // Malformed `$id` — leave baseUri unchanged; Ajv would have
        // flagged it in stage 2 anyway.
      }
    }

    const ref = node['$ref'];
    if (typeof ref === 'string') {
      this.checkRef(ref, currentBase, rootId);
    }

    // Recurse over every value; keyword-aware filtering isn't needed here
    // because `checkRef` only fires on the `$ref` key and `$id` is
    // re-evaluated at every depth.
    for (const [key, value] of Object.entries(node)) {
      if (key === '$id' || key === '$ref') continue;
      this.walkResolveRefs(value, currentBase, rootId);
    }
  }

  private checkRef(ref: string, baseUri: string, rootId: string): void {
    if (ref.startsWith('git+') || ref.startsWith('npm:')) {
      throw new ContractsValidationError(
        `stage 4: remote \`$ref\` '${ref}' is out of scope for v1.0; ` +
          `move the target schema into a local source declared in \`loopback.config.json\``,
        {sourcePath: rootId, instancePath: '/$ref', schemaId: rootId},
      );
    }

    // Per RFC 3986 §5.3 — resolve `$ref` against the active base URI so
    // both absolute (`http(s)://…`) and relative refs (`foo.schema.json`,
    // `#/$defs/Bar`) map to a canonical absolute identifier.
    let resolved: string;
    try {
      resolved = new URL(ref, baseUri).href;
    } catch {
      throw new ContractsValidationError(
        `stage 4: \`$ref\` '${ref}' from schema '${rootId}' is not a valid URI reference`,
        {sourcePath: rootId, instancePath: '/$ref', schemaId: rootId},
      );
    }

    // Strip the fragment — the registry keys on `$id` (no fragment); any
    // fragment is a JSON Pointer into the resolved document and is
    // validated lazily by Ajv at consumption time.
    const hashAt = resolved.indexOf('#');
    const target = hashAt >= 0 ? resolved.slice(0, hashAt) : resolved;

    // Same-document fragment ref (`#/$defs/Foo`) resolves to the base
    // URI itself; the base IS a registered schema by construction.
    //
    // TODO(v1.1): RFC 3986 §6 URI equivalence — fold case-insensitive
    // scheme/host, drop default ports (80 for http, 443 for https), and
    // normalise percent-encoding before comparing `target` to `baseUri`
    // and before `registry.has(target)`. Today two semantically-equal
    // refs that differ only in case (`HTTPS://Example.COM/...` vs
    // `https://example.com/...`) or in default-port form
    // (`https://example.com:443/x` vs `https://example.com/x`) would
    // dangling-ref-error even though they reference the same schema.
    // Low impact in practice (authors copy `$id` verbatim) and gated
    // behind a URL canonicaliser; deferring rather than rushing a
    // half-correct implementation in.
    if (target.length === 0 || target === baseUri) return;

    if (!this.registry.has(target)) {
      throw new ContractsValidationError(
        `stage 4: dangling \`$ref\` '${ref}' from schema '${rootId}' — ` +
          `resolved to '${target}' but no schema with that \`$id\` was loaded`,
        {sourcePath: rootId, instancePath: '/$ref', schemaId: rootId},
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
    const modelConfigMeta = buildModelConfigMetaSchema(schemas, datasources);
    const datasourcesMeta = buildDatasourcesMetaSchema(installedAdapters);
    const emitterManifestMeta = buildEmitterManifestMetaSchema();
    // Collect the registered emitter kinds so the loopback-config meta-
    // schema can constrain `emit.*` boolean slots to the real kind enum
    // — a typo like `emit.zodd` then fails meta-schema validation
    // instead of silently disabling the intended emitter. CLI-side
    // validation in `cli-context.ts` compiles the same builder with an
    // empty enum, so this is the engine's "second validation pass" that
    // catches the typo.
    const emitterKinds = (await this.emitters.all()).map(e => e.kind);
    const loopbackConfigMeta = buildLoopbackConfigMetaSchema(emitterKinds);

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

  private async stage6DiffBreakingChanges(
    opts: PipelineRunOptions,
  ): Promise<DiffStateCache> {
    const cache = await loadDiffStateCache(opts.projectRoot);
    const next: DiffStateCache = {version: 1, entries: {}};
    const refusals: string[] = [];

    // Iterate each schema against its own originating descriptor (recorded
    // in stage 2) instead of doing an `N × M` Cartesian over every
    // descriptor in the project. Schemas with no recorded origin are
    // skipped — they cannot have come from a configured source so the
    // diff has no descriptor to anchor to.
    for (const schema of this.registry.list()) {
      const id = schema.$id;
      if (typeof id !== 'string' || id.length === 0) continue;
      const descriptor = this.schemaOrigins.get(id);
      if (descriptor === undefined) continue;
      const pin = extractPin(descriptor);
      const cacheKey = `${descriptor}@${id}`;
      const previous = cache.entries[cacheKey];
      const canonical = canonicalJsonStringify(schema);

      // Only diff when a version pin actually changed. Missing previous
      // record or matching pin means nothing to compare.
      if (previous && previous.pin !== pin) {
        let prevSchema: JSONSchema | undefined;
        try {
          const parsed: unknown = JSON.parse(previous.schemaJson);
          // Runtime shape guard — `JSON.parse` returns `unknown` and the
          // cache file is user-readable, so a hand-edited entry could
          // contain `null`, a string, or any other JSON value. A
          // non-object would slip through Ajv's later checks because the
          // diff classifier reads properties off the value directly.
          // Treat it the same as a corrupt entry.
          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            Array.isArray(parsed)
          ) {
            throw new ContractsCodegenError(
              `diff-state cache entry for '${cacheKey}' is not a JSON object ` +
                `(got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed})`,
              {emitterKind: 'pipeline', schemaId: id},
            );
          }
          prevSchema = parsed as JSONSchema;
        } catch (err) {
          // Corrupted cache entry — surface a warn-level lossy report
          // naming the offending cache key and SKIP the diff. The
          // previous behaviour silently compared the schema against
          // itself, which always produced `unchanged` and so hid any
          // genuine breaking change on this descriptor flip.
          this.lossy.report({
            feature: 'diff-cache-corrupt',
            source: {schemaId: id},
            severity: 'warn',
            message:
              `diff-state cache entry for '${cacheKey}' is corrupt ` +
              `(${(err as Error).message}); skipping backward-compat diff ` +
              `for this schema this run. The entry will be rewritten on success.`,
          });
        }
        if (prevSchema !== undefined) {
          const verdict = classifyDiff(prevSchema, schema);
          if (verdict === 'breaking') {
            const strategy = opts.config['migration-strategy']?.[id];
            const allowedByStrategy = strategy?.mode === 'allow';
            if (!opts.allowBreaking && !allowedByStrategy) {
              refusals.push(
                `breaking change in '${id}' (${previous.pin} -> ${pin})`,
              );
            }
          }
        }
      }

      next.entries[cacheKey] = {
        descriptor,
        schemaId: id,
        pin,
        schemaJson: canonical,
      };
    }

    if (refusals.length > 0) {
      throw new ContractsPipelineError(
        `stage 6: refusing to proceed; ${refusals.length} breaking schema change(s) detected: ${refusals.join('; ')}. ` +
          `Re-run with --allow-breaking or declare \`migration-strategy.<schemaId>.mode = 'allow'\` in loopback.config.json.`,
        {stage: 'backward-compat-diff'},
      );
    }

    return next;
  }

  /**
   * Persist the next diff-state baseline atomically. Writes to a sibling
   * tmp file in the same directory, `fsync`s the tmp for POSIX durability
   * (mirroring `file-writer.ts:writeTmpDurable`), then `rename`s it into
   * place — POSIX (and NTFS) guarantee `rename` within a directory is
   * atomic, so a crash mid-write can never leave `diff-state.json`
   * half-written and corrupt the next run's baseline. On any failure, a
   * best-effort `unlink` clears the tmp; the original error is re-raised.
   *
   * The cache is rebuildable from the schema set, so a missing `fsync`
   * implementation on the underlying filesystem (some network mounts,
   * Windows ReFS) is not fatal — the call is wrapped and surfaced via the
   * `debug` channel (`DEBUG=loopback:contracts:pipeline`) instead of
   * thrown, matching `writeTmpDurable`'s policy.
   */
  private async persistDiffStateCache(
    opts: PipelineRunOptions,
    next: DiffStateCache,
  ): Promise<void> {
    const cachePath = diffStateCachePath(opts.projectRoot);
    await mkdir(dirname(cachePath), {recursive: true});
    const tmpPath = `${cachePath}.tmp.${randomBytes(6).toString('hex')}`;
    const json = JSON.stringify(next, null, 2) + '\n';
    try {
      const handle = await open(tmpPath, 'w');
      try {
        await handle.writeFile(json);
        try {
          await handle.sync();
        } catch (err) {
          debug('fsync unsupported on %s: %s', tmpPath, (err as Error).message);
        }
      } finally {
        await handle.close();
      }
      await rename(tmpPath, cachePath);
    } catch (err) {
      // Best-effort cleanup — never mask the original error.
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
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
    const allFiles: readonly EmittedFile[] = [
      ...transformedFiles,
      ...barrelFiles,
      ...this.writeQueue,
    ];
    const perFileRoots = new Map<string, string>();
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
      return `  - ${path} ${e.message ?? ''} [keyword=${e.keyword}]`;
    })
    .join('\n');
}

/**
 * Pull a version pin out of a descriptor:
 *   - `git+…#v1.2.0` -\> `v1.2.0`
 *   - `git+…?ref=sha` -\> `sha`
 *   - `npm:pkg@1.2.0` -\> `1.2.0`
 *   - bare path or unpinned URL -\> `''`
 */
function extractPin(descriptor: string): string {
  const hash = descriptor.indexOf('#');
  if (hash >= 0) return descriptor.slice(hash + 1);
  const refMatch = /[?&]ref=([^&]+)/.exec(descriptor);
  if (refMatch && refMatch[1] !== undefined) return refMatch[1];
  if (descriptor.startsWith('npm:')) {
    const at = descriptor.lastIndexOf('@');
    if (at > 'npm:'.length) return descriptor.slice(at + 1);
  }
  return '';
}

/**
 * Stable, key-sorted JSON serialisation. Throws on object-identity cycles
 * because cyclic schemas have no canonical encoding — silently returning
 * `null` for the cycle would let two schemas that differ only inside a
 * cycle hash-compare equal, defeating stage 3's collision check and stage
 * 6's breaking-change diff. JSON Schema documents must be DAGs (deep
 * `$ref` cycles are JSON Pointers, not object cycles), so a real cycle
 * here means upstream data corruption — surface it loudly.
 *
 * @throws ContractsCodegenError When `value` contains an object cycle.
 */
function canonicalJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object') {
      if (seen.has(v as object)) {
        throw new ContractsCodegenError(
          'canonicalJsonStringify: refusing to serialise object cycle; ' +
            'JSON Schema documents must be acyclic by object identity',
          {emitterKind: 'pipeline', schemaId: '<canonical-json>'},
        );
      }
      seen.add(v as object);
      const entries = Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => [k, visit(val)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries);
    }
    return v;
  };
  return JSON.stringify(visit(value));
}

/**
 * Classify a shape diff between an old and a new JSON Schema as one of:
 *
 *   - `unchanged` — canonical JSON identical.
 *   - `additive` — every inspected change strictly grows the accepted
 *     set (new optional property, required-to-optional promotion, enum
 *     widening).
 *   - `narrowing` — type-set or `enum` shrinks without removals.
 *   - `breaking` — any property removal, type mismatch, optional-to-
 *     required transition, `additionalProperties: true -> false`,
 *     `enum` shrinkage (new is a strict subset of old), `pattern`
 *     change, `format` change, `minLength`/`minimum`/`maxLength`/
 *     `maximum`/`exclusiveMinimum`/`exclusiveMaximum`/`multipleOf`
 *     tightening, or any difference inside `oneOf`/`anyOf`/`allOf`/
 *     `$ref`/`if`/`then`/`else`/`not`/`items`/`prefixItems`/`contains`.
 *
 * After the inspected-keys check, any remaining canonical-JSON delta in
 * keywords NOT inspected here downgrades to `breaking` rather than
 * `additive` — the differ should err conservative for the v1.0 gate.
 *
 * Heuristic limits — this is not a full semantic differ:
 *
 *   - Cross-keyword interactions are not modelled (e.g., `oneOf` rewrite
 *     into an equivalent `if`/`then`/`else` still counts as breaking).
 *   - Tuple-positional `items` rearrangement is not detected separately
 *     from a swap; both produce `breaking` via the "any change inside
 *     items" rule above.
 *   - Numeric range tightening uses `<` / `>` on raw numbers without
 *     normalising integer vs number representations.
 *   - String `pattern` comparison is purely syntactic — semantically
 *     equivalent regexes (`a|b` vs `b|a`) count as breaking.
 *   - The classifier walks the schema root only. Property-level
 *     subschemas are inspected for type and presence, but their own
 *     nested keywords (e.g., a property whose schema gains a stricter
 *     `pattern`) are caught only by the conservative "remaining
 *     canonical difference" fallback.
 *
 * Override with `migration-strategy.<schemaId>.mode = 'allow'` in
 * `loopback.config.json` when the heuristic is wrong for a given
 * schema.
 */
function classifyDiff(prev: JSONSchema, next: JSONSchema): DiffClassification {
  const prevCanon = canonicalJsonStringify(prev);
  const nextCanon = canonicalJsonStringify(next);
  if (prevCanon === nextCanon) return 'unchanged';

  let verdict: DiffClassification = 'additive';
  const prevRec = prev as unknown as Record<string, unknown>;
  const nextRec = next as unknown as Record<string, unknown>;

  // additionalProperties: true -> false (or omitted -> false) closes the
  // accepted set; any payload with a previously-tolerated extra property
  // now fails. Breaking.
  const prevAP = prevRec['additionalProperties'];
  const nextAP = nextRec['additionalProperties'];
  if (prevAP !== false && nextAP === false) return 'breaking';

  // enum: shrinkage (new subset of old) drops accepted values. Strict
  // widening is additive; any value removed is breaking.
  if (Array.isArray(prevRec['enum']) && Array.isArray(nextRec['enum'])) {
    const nextEnumSet = new Set(nextRec['enum'] as unknown[]);
    for (const v of prevRec['enum'] as unknown[]) {
      if (!nextEnumSet.has(v)) return 'breaking';
    }
    if (nextEnumSet.size < (prevRec['enum'] as unknown[]).length) {
      verdict = verdict === 'additive' ? 'narrowing' : verdict;
    }
  } else if ('enum' in prevRec && !('enum' in nextRec)) {
    // Dropping the enum constraint widens the accepted set — additive.
  } else if (!('enum' in prevRec) && 'enum' in nextRec) {
    // Adding an enum where none existed narrows to a finite set —
    // breaking for any payload outside the new set.
    return 'breaking';
  }

  // pattern / format: any change is breaking (purely syntactic diff —
  // semantically equivalent regexes still trip this; the override knob
  // exists for the false-positive case).
  if (
    typeof prevRec['pattern'] === 'string' &&
    prevRec['pattern'] !== nextRec['pattern']
  ) {
    return 'breaking';
  }
  if ('pattern' in nextRec && !('pattern' in prevRec)) return 'breaking';
  if (
    typeof prevRec['format'] === 'string' &&
    prevRec['format'] !== nextRec['format']
  ) {
    return 'breaking';
  }
  if ('format' in nextRec && !('format' in prevRec)) return 'breaking';

  // Numeric / length tightening — new bound is strictly more
  // restrictive than the old one. Loosening or removing is additive.
  if (tightens(prevRec['minLength'], nextRec['minLength'], 'increase')) {
    return 'breaking';
  }
  if (tightens(prevRec['maxLength'], nextRec['maxLength'], 'decrease')) {
    return 'breaking';
  }
  if (tightens(prevRec['minimum'], nextRec['minimum'], 'increase')) {
    return 'breaking';
  }
  if (tightens(prevRec['maximum'], nextRec['maximum'], 'decrease')) {
    return 'breaking';
  }
  if (
    tightens(
      prevRec['exclusiveMinimum'],
      nextRec['exclusiveMinimum'],
      'increase',
    )
  ) {
    return 'breaking';
  }
  if (
    tightens(
      prevRec['exclusiveMaximum'],
      nextRec['exclusiveMaximum'],
      'decrease',
    )
  ) {
    return 'breaking';
  }
  if (tightens(prevRec['minItems'], nextRec['minItems'], 'increase')) {
    return 'breaking';
  }
  if (tightens(prevRec['maxItems'], nextRec['maxItems'], 'decrease')) {
    return 'breaking';
  }
  if (
    tightens(prevRec['minProperties'], nextRec['minProperties'], 'increase')
  ) {
    return 'breaking';
  }
  if (
    tightens(prevRec['maxProperties'], nextRec['maxProperties'], 'decrease')
  ) {
    return 'breaking';
  }

  // Any structural change inside oneOf/anyOf/allOf/$ref/items/etc. —
  // the differ doesn't recurse, so any canonical-JSON delta in these
  // keywords is treated as breaking.
  for (const k of COMPOSITION_KEYWORDS) {
    const a = prevRec[k];
    const b = nextRec[k];
    if (canonicalKeywordDiffers(a, b)) return 'breaking';
  }

  const prevProps = (prev.properties ?? {}) as Record<string, JSONSchema>;
  const nextProps = (next.properties ?? {}) as Record<string, JSONSchema>;
  const prevRequired = new Set(prev.required ?? []);
  const nextRequired = new Set(next.required ?? []);

  // Removed property -> breaking.
  for (const k of Object.keys(prevProps)) {
    if (!(k in nextProps)) return 'breaking';
  }
  // Optional -> required on a pre-existing property -> breaking.
  for (const k of nextRequired) {
    if (!prevRequired.has(k) && k in prevProps) return 'breaking';
  }
  // Required -> optional is additive; no verdict change needed.

  // Per-property type comparison + any nested canonical change
  // downgrades the verdict per the conservative fallback rule.
  for (const [k, nextProp] of Object.entries(nextProps)) {
    const prevProp = prevProps[k];
    if (!prevProp) continue; // brand-new property is additive
    if (
      typeof prevProp.type === 'string' &&
      typeof nextProp.type === 'string'
    ) {
      if (prevProp.type !== nextProp.type) return 'breaking';
    } else if (Array.isArray(prevProp.type) && Array.isArray(nextProp.type)) {
      const prevTypes = new Set(prevProp.type);
      const nextTypes = new Set(nextProp.type);
      for (const t of prevTypes) {
        if (!nextTypes.has(t)) return 'breaking';
      }
      if (nextTypes.size < prevTypes.size) {
        verdict = verdict === 'additive' ? 'narrowing' : verdict;
      }
    } else if (
      canonicalKeywordDiffers(prevProp as unknown, nextProp as unknown)
    ) {
      // Any nested property-schema change we didn't recognise — be
      // conservative.
      return 'breaking';
    }
  }

  // Root-level type comparison — same rule as per-property.
  if (
    typeof prevRec['type'] === 'string' &&
    typeof nextRec['type'] === 'string' &&
    prevRec['type'] !== nextRec['type']
  ) {
    return 'breaking';
  }

  // Conservative fallback: if any inspected keyword changed and we
  // already returned, we never get here. If we get here the canonical
  // strings still differ, meaning the delta lives entirely in
  // un-inspected keywords. Downgrade to `breaking` rather than
  // `additive` — better a false-positive the user can override than a
  // missed regression.
  if (prevCanon !== nextCanon && verdict === 'additive') {
    return 'breaking';
  }

  return verdict;
}

const COMPOSITION_KEYWORDS = [
  'oneOf',
  'anyOf',
  'allOf',
  'not',
  '$ref',
  'if',
  'then',
  'else',
  'items',
  'prefixItems',
  'contains',
  'propertyNames',
  'patternProperties',
] as const;

/**
 * Compare two keyword values by canonical JSON. Used by the
 * classifyDiff composition-keyword fallback to avoid duplicating the
 * "any nested change is breaking" rule per keyword.
 */
function canonicalKeywordDiffers(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return false;
  if (a === undefined || b === undefined) return true;
  return canonicalJsonStringify(a) !== canonicalJsonStringify(b);
}

/**
 * Numeric tightening check used by classifyDiff. `direction` says
 * which side moves to make the bound stricter (`increase` for `min*`
 * keywords, `decrease` for `max*`). Returns true only when both values
 * are finite numbers and the new value is strictly stricter.
 */
function tightens(
  prev: unknown,
  next: unknown,
  direction: 'increase' | 'decrease',
): boolean {
  if (typeof prev !== 'number' || typeof next !== 'number') {
    // Adding a bound where none existed is breaking.
    if (typeof prev !== 'number' && typeof next === 'number') return true;
    return false;
  }
  return direction === 'increase' ? next > prev : next < prev;
}

function diffStateCachePath(projectRoot: string): string {
  return resolve(projectRoot, '.loopback', 'cache', 'diff-state.json');
}

async function loadDiffStateCache(
  projectRoot: string,
): Promise<DiffStateCache> {
  const path = diffStateCachePath(projectRoot);
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as DiffStateCache;
    if (parsed && parsed.version === 1 && parsed.entries) return parsed;
    return {version: 1, entries: {}};
  } catch {
    return {version: 1, entries: {}};
  }
}

/**
 * Load `<projectRoot>/datasources.json` and return a flat
 * `DatasourceConfigJson[]` regardless of which on-disk layout the project
 * uses. Two layouts are accepted, in lock-step with
 * `normaliseDatasources()` in `src/generators/datasource-generator.ts`:
 *
 *   - Array form: `[{"name": "primary", "adapter": "mongodb", ...}, ...]`
 *   - Keyed-map form: `{"primary": {"adapter": "mongodb", ...}, ...}` —
 *     preferred shape (`lb4 ds` writes this). The optional `$schema`
 *     key is skipped. Each entry is normalised by folding the map key
 *     in as the entry's `name` field so the returned array shape is
 *     uniform across both layouts.
 *
 * Missing or unreadable `datasources.json` returns `[]`. A malformed
 * entry (non-object value, string value other than `$schema`) is also
 * dropped silently here — stage 5's meta-schema validation catches
 * shape-level problems with a richer error, so this loader stays a
 * simple parse-and-normalise pass.
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
 * Other I/O errors (EPERM, EISDIR, EMFILE, etc.) and JSON parse failures
 * surface as typed {@link ContractsValidationError}s so the root cause
 * isn't mis-attributed to "no datasources declared".
 */
async function loadRawDatasources(
  projectRoot: string,
): Promise<{readonly raw: unknown; readonly path: string} | undefined> {
  const path = resolve(projectRoot, 'datasources.json');
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ContractsValidationError(
      `stage 5: failed to read datasources.json: ${(err as Error).message}`,
      {sourcePath: path, instancePath: ''},
      {cause: err},
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (cause) {
    throw new ContractsValidationError(
      `stage 5: invalid JSON in datasources.json: ${(cause as Error).message}`,
      {sourcePath: path, instancePath: ''},
      {cause},
    );
  }
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
 * Silent on every failure mode (missing file, unreadable file, malformed
 * JSON, non-object root) — adapter-enum hinting is an authoring nicety,
 * not a validation gate, so a broken `package.json` should never abort
 * a `lb-contracts gen` run that would otherwise succeed.
 */
async function discoverInstalledAdapters(
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
  const pattern = /^loopback-connector-(.+)$/;
  for (const section of sections) {
    const entries = (pkg as Record<string, unknown>)[section];
    if (!isPlainObject(entries)) continue;
    for (const name of Object.keys(entries)) {
      const match = pattern.exec(name);
      if (match && match[1] !== undefined && match[1].length > 0) {
        out.add(match[1]);
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
