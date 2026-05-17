import {
  Application,
  BindingScope,
  createBindingFromClass,
  injectable,
} from '@loopback/core';
import {describe, expect, it} from 'vitest';
import {ContractsComponent} from '../../contracts.component';
import {EmitterRegistry, EmitterRunner} from '../../engine';
// `topologicalSort` is engine-internal and intentionally NOT re-exported
// through the engine barrel; import the deep path so this spec can exercise
// it directly without widening the engine's public surface.
import {topologicalSort} from '../../engine/emitter-runner';
import {ContractsEngineBindings} from '../../engine/tokens';
import type {
  EmittedFile,
  EmitterContext,
  JSONSchema,
  ProjectionEmitter,
} from '../../interfaces';
import {ContractsBindings, EMITTER_TAG} from '../../keys';

// --- helpers ---------------------------------------------------------------

// Build a minimal JSONSchema with a single $ref edge per target. Each
// $id is used both as the registry key and as the resolvable target,
// matching the `collectRefs()` rule that strips the JSON Pointer fragment
// and looks the prefix up in the by-id map.
function schema(id: string, refs: readonly string[] = []): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  refs.forEach((ref, i) => {
    properties[`ref${i}`] = {$ref: ref};
  });
  return {$id: id, type: 'object', properties};
}

function ids(list: readonly JSONSchema[]): string[] {
  return list.map(s => (typeof s.$id === 'string' ? s.$id : '<no-id>'));
}

// --- topologicalSort: direct tests ----------------------------------------

describe('topologicalSort (direct)', () => {
  it('orders a DAG with dependencies before dependents', () => {
    // A -> B, A -> C, B -> D. Expect D, then B, then C, then A.
    const d = schema('D');
    const b = schema('B', ['D']);
    const c = schema('C');
    const a = schema('A', ['B', 'C']);

    const ordered = topologicalSort([a, b, c, d]);

    // Every dependency must come before its dependents.
    const pos = (id: string): number => ordered.findIndex(s => s.$id === id);
    expect(pos('D')).toBeLessThan(pos('B'));
    expect(pos('B')).toBeLessThan(pos('A'));
    expect(pos('C')).toBeLessThan(pos('A'));

    // Exhaustive and de-duplicated.
    expect(ordered).toHaveLength(4);
    expect(new Set(ids(ordered)).size).toBe(4);
  });

  it('emits every member of a mutual A<->B cycle exactly once', () => {
    const a = schema('A', ['B']);
    const b = schema('B', ['A']);

    const ordered = topologicalSort([a, b]);

    // Both nodes appear and only once each.
    expect(ordered).toHaveLength(2);
    expect(ids(ordered).sort()).toEqual(['A', 'B']);

    // Outer loop walks schemas sorted by $id, so A enters the DFS first.
    // A's child B is visited (and finishes) before A finishes — so the
    // post-order push yields [B, A], which is the order the cycle was
    // first entered (A -> B -> back-edge -> finish B -> finish A).
    expect(ids(ordered)).toEqual(['B', 'A']);
  });

  it('emits every member of a 3-cycle A->B->C->A exactly once', () => {
    const a = schema('A', ['B']);
    const b = schema('B', ['C']);
    const c = schema('C', ['A']);

    // Input order intentionally shuffled to prove the result is driven by
    // $id-sorted entry order, not input order.
    const ordered = topologicalSort([c, b, a]);

    expect(ordered).toHaveLength(3);
    expect(ids(ordered).sort()).toEqual(['A', 'B', 'C']);

    // A enters first ($id sort), pushes B, then C, then back-edge to A.
    // Post-order pops give [C, B, A].
    expect(ids(ordered)).toEqual(['C', 'B', 'A']);
  });

  it('is deterministic across runs regardless of input ordering', () => {
    const build = (): readonly JSONSchema[] => [
      schema('A', ['B', 'C']),
      schema('B', ['D']),
      schema('C'),
      schema('D'),
    ];

    const run1 = ids(topologicalSort(build()));
    const run2 = ids(topologicalSort(build().slice().reverse()));
    expect(run1).toEqual(run2);
  });

  it('returns the input untouched when length <= 1', () => {
    const empty: readonly JSONSchema[] = [];
    expect(topologicalSort(empty)).toBe(empty);

    const one = [schema('A')];
    expect(topologicalSort(one)).toBe(one);
  });
});

// --- EmitterRunner.run(): records emit order through a stub ---------------

// Stub emitter that records the $id of every schema it sees. Tagged so
// the EmitterRegistry's extension-view picks it up alongside the built-ins.
@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[EMITTER_TAG]: EMITTER_TAG, kind: 'topo-recorder'},
})
class RecorderEmitter implements ProjectionEmitter {
  readonly kind = 'topo-recorder';
  readonly outputSuffix = '.topo.txt';
  readonly tier = 'convenience' as const;
  readonly description = 'records emit order for topological-sort tests';

  readonly seen: string[] = [];

  emit(ctx: EmitterContext): EmittedFile[] {
    const id = typeof ctx.schema.$id === 'string' ? ctx.schema.$id : '<no-id>';
    this.seen.push(id);
    return [];
  }
}

async function buildRunnerApp(): Promise<{
  app: Application;
  runner: EmitterRunner;
  recorder: RecorderEmitter;
}> {
  const app = new Application();
  app.component(ContractsComponent);

  // Wire the engine bindings the runner depends on. The registry resolves
  // emitters via the extension-view, so a tagged binding is all we need.
  app
    .bind(ContractsEngineBindings.EMITTER_REGISTRY)
    .toClass(EmitterRegistry)
    .inScope(BindingScope.SINGLETON);
  app
    .bind(ContractsEngineBindings.EMITTER_RUNNER)
    .toClass(EmitterRunner)
    .inScope(BindingScope.SINGLETON);

  // Stubs for the per-emitter context inputs — none of these are exercised
  // by RecorderEmitter beyond identity, so empty/no-op implementations are
  // sufficient and keep the test focused on ordering.
  app.bind(ContractsBindings.SCHEMA_REGISTRY).to({
    get: () => undefined,
    list: () => [],
    has: () => false,
  });
  app.bind(ContractsBindings.IMPORT_MAP).to({
    resolve: () => '',
  });
  app.bind(ContractsBindings.TEMPLATE_ENGINE).to({
    preload: async () => {},
    render: () => '',
  });
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

  const recorderBinding = createBindingFromClass(RecorderEmitter);
  app.add(recorderBinding);

  const runner = await app.get<EmitterRunner>(
    ContractsEngineBindings.EMITTER_RUNNER,
  );
  const recorder = (await app.get<RecorderEmitter>(
    recorderBinding.key,
  )) as RecorderEmitter;
  return {app, runner, recorder};
}

describe('EmitterRunner.run() emits schemas in topological order', () => {
  it('DAG: emits leaves first, root last', async () => {
    const {runner, recorder} = await buildRunnerApp();
    const d = schema('D');
    const b = schema('B', ['D']);
    const c = schema('C');
    const a = schema('A', ['B', 'C']);

    // Only the recorder is enabled — every built-in emitter is left out
    // so the recorded sequence reflects topological order exclusively.
    await runner.run([a, b, c, d], {'topo-recorder': true});

    // Outer loop walks roots in $id order (A, B, C, D). A enters first; its
    // children sort to [B, C]; visit B -> D -> finish D -> finish B -> visit
    // C -> finish C -> finish A. Post-order push yields [D, B, C, A]. The
    // remaining roots (B, C, D) are already `done` and produce no new emits.
    expect(recorder.seen).toEqual(['D', 'B', 'C', 'A']);
  });

  it('mutual cycle: both members emitted, deterministic entry order', async () => {
    const {runner, recorder} = await buildRunnerApp();
    const a = schema('A', ['B']);
    const b = schema('B', ['A']);

    await runner.run([a, b], {'topo-recorder': true});

    expect(recorder.seen).toEqual(['B', 'A']);
  });

  it('3-cycle: all members emitted, deterministic entry order', async () => {
    const {runner, recorder} = await buildRunnerApp();
    const a = schema('A', ['B']);
    const b = schema('B', ['C']);
    const c = schema('C', ['A']);

    await runner.run([c, b, a], {'topo-recorder': true});

    expect(recorder.seen).toEqual(['C', 'B', 'A']);
  });
});

// ---------------------------------------------------------------------------
// outputScope: 'per-project' — the runner must call emit() exactly once per
// pipeline run rather than per-schema. Datasource generation drives this
// case in production; the test uses an isolated recorder so it doesn't
// depend on the generator's filesystem reads.
// ---------------------------------------------------------------------------

@injectable({
  scope: BindingScope.SINGLETON,
  tags: {[EMITTER_TAG]: EMITTER_TAG, kind: 'topo-project-recorder'},
})
class ProjectScopeRecorder implements ProjectionEmitter {
  readonly kind = 'topo-project-recorder';
  readonly outputSuffix = '.topo.project.txt';
  readonly tier = 'convenience' as const;
  readonly description = 'records emit() call count for outputScope tests';
  readonly outputScope = 'per-project' as const;

  readonly seen: string[] = [];

  emit(ctx: EmitterContext): EmittedFile[] {
    const id = typeof ctx.schema.$id === 'string' ? ctx.schema.$id : '<no-id>';
    this.seen.push(id);
    return [];
  }
}

async function buildProjectRecorderApp(): Promise<{
  runner: EmitterRunner;
  recorder: ProjectScopeRecorder;
}> {
  const app = new Application();
  app.component(ContractsComponent);
  app
    .bind(ContractsEngineBindings.EMITTER_REGISTRY)
    .toClass(EmitterRegistry)
    .inScope(BindingScope.SINGLETON);
  app
    .bind(ContractsEngineBindings.EMITTER_RUNNER)
    .toClass(EmitterRunner)
    .inScope(BindingScope.SINGLETON);
  app.bind(ContractsBindings.SCHEMA_REGISTRY).to({
    get: () => undefined,
    list: () => [],
    has: () => false,
  });
  app.bind(ContractsBindings.IMPORT_MAP).to({resolve: () => ''});
  app.bind(ContractsBindings.TEMPLATE_ENGINE).to({
    preload: async () => {},
    render: () => '',
  });
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

  const binding = createBindingFromClass(ProjectScopeRecorder);
  app.add(binding);

  const runner = await app.get<EmitterRunner>(
    ContractsEngineBindings.EMITTER_RUNNER,
  );
  const recorder = (await app.get<ProjectScopeRecorder>(
    binding.key,
  )) as ProjectScopeRecorder;
  return {runner, recorder};
}

describe("EmitterRunner.run() respects outputScope: 'per-project'", () => {
  it('invokes emit() exactly once with the first schema in topological order', async () => {
    const {runner, recorder} = await buildProjectRecorderApp();
    const a = schema('A', ['B']);
    const b = schema('B', ['C']);
    const c = schema('C');

    await runner.run([a, b, c], {'topo-project-recorder': true});

    // 3 schemas in the input, but a per-project emitter fires once.
    // Topological order is leaves first ([C, B, A]); the runner passes
    // the first entry (C) as `ctx.schema`.
    expect(recorder.seen).toEqual(['C']);
  });

  it('still fires once when only one schema exists', async () => {
    const {runner, recorder} = await buildProjectRecorderApp();
    const only = schema('only');

    await runner.run([only], {'topo-project-recorder': true});

    expect(recorder.seen).toEqual(['only']);
  });
});
