# LoopBack 4 Plugin TypeScript Style Guide

Status: draft, version 0.1.0

## 1. Scope & relationship to Google TS Guide

This guide applies to any TypeScript LoopBack 4 plugin, component, connector, extension, or shared library distributed as an npm package.

It adopts the [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) by reference as the foundation. Google's rules are in effect unless this document explicitly overrides them. This document records:

- Overrides where LoopBack 4 conventions diverge from Google.
- Additions that codify LoopBack-specific patterns no published guide covers.

When this guide is silent, fall back to Google. When this guide and Google conflict, this guide wins inside LoopBack 4 plugins.

For framework patterns (IoC, dependency injection, extension points, interceptors, lifecycle observers, components), defer to LoopBack's official [`loopback-core` skill](https://github.com/loopbackio/loopback-next/tree/master/skills/loopback-core) and its references. This style guide layers plugin-author discipline on top of those patterns; it does not redefine them.

## 2. File naming

Override Google. Source files use dot-kebab naming, not snake_case:

```
user.controller.ts
user.service.ts
user.service.impl.ts
user.repository.ts
user.model.ts
mongo.datasource.ts
mongo.component.ts
audit.observer.ts
auth.interceptor.ts
mongo.datasource.provider.ts
```

Why:

- The LoopBack CLI scaffolds files in this format; tooling, generators, and migrations expect it.
- The artifact suffix (`.controller`, `.service`) is a typed-grep affordance — `rg --files -g '*.repository.ts'` enumerates all repositories in a workspace.
- Ecosystem consistency: every published `@loopback/*` package follows it.

Implementation files for an interface use a `.impl.ts` suffix in the same directory as the interface:

```
services/
  user.service.ts        // interface, types
  user.service.impl.ts   // default implementation
```

Test files mirror their target with a `.spec.ts` suffix and live under `__tests__/`, never beside the source.

Non-artifact files (pure helpers, types, internal utilities) use kebab-case without an artifact suffix: `connection-manager.ts`, `query-builder.ts`, `url-builder.ts`, `types.ts`, `keys.ts`.

## 3. Folder structure

A plugin's source tree:

```
src/
  controllers/
  services/
  repositories/
  models/
  datasources/
  observers/
  interceptors/
  providers/
  helpers/
  __tests__/
    unit/
    integration/
  keys.ts
  types.ts
  index.ts
  my-plugin.component.ts
```

Rules:

- One artifact per file. A `*.controller.ts` exports exactly one controller.
- `helpers/` holds framework-free pure modules. No `@loopback/*` imports if avoidable; if needed, they must be type-only.
- `keys.ts` lives at the package root, never inside a subfolder, because every other folder imports it.
- `types.ts` at the package root holds the plugin's public configuration and DTO types.
- `index.ts` is the package's public barrel. It re-exports only `@public` and `@experimental` symbols.
- `__tests__/` is the sole test location. Do not co-locate `*.spec.ts` next to source.

A plugin that exposes binding keys must always ship `keys.ts`.

## 4. Binding keys

Every binding is created through `BindingKey.create<T>('namespace.subspace.name')`. Untyped bindings are forbidden.

Group all binding keys under a single namespace object named `<Plugin>Bindings` exported from `keys.ts`:

```typescript
import {BindingKey} from '@loopback/core';
import type {juggler} from '@loopback/repository';
import type {MongoService} from './services/mongo.service';
import type {MongoConnectorConfig} from './types';

export namespace MongoBindings {
  export const CONFIG = BindingKey.create<MongoConnectorConfig>('mongo.config');
  export const SERVICE = BindingKey.create<MongoService>('mongo.service');
  export const DATASOURCE =
    BindingKey.create<juggler.DataSource>('datasources.mongo');
}
```

Rules:

- Binding key strings mirror domain ownership. Use dot-namespaced lowercase: `auth.token-service`, `mongo.connection-manager`, `datasources.mongo`. The first segment is the plugin's domain and must not collide with `@loopback/*` reserved namespaces (`controllers.*`, `datasources.*` for the framework-owned slot, `services.*`).
- Use `import type` for the value type. This breaks the runtime cycle that otherwise forms between `keys.ts` and the implementation it names. Why: `keys.ts` is imported by every file in the plugin; if it pulls in runtime modules, every consumer drags the whole graph.
- One namespace per plugin. Do not split keys across multiple files.
- Never export raw string literals — only `BindingKey` instances.

When binding into a framework slot (e.g. `datasources.mongo`), use the framework's prefix, not your plugin's.

## 5. Provider pattern

When constructing the bound value requires logic, injected dependencies, or async resolution, use a `Provider<T>` with a single `value()` method:

```typescript
import {inject, Provider} from '@loopback/core';
import {juggler} from '@loopback/repository';
import {MongoBindings} from '../keys';
import {MongoConnectionManager} from '../helpers/connection-manager';
import {MongoConnectorConfig} from '../types';
import {MongoDataSource} from './mongo.datasource';

export class MongoDataSourceProvider implements Provider<juggler.DataSource> {
  constructor(
    @inject(MongoBindings.CONFIG, {optional: true})
    private config: MongoConnectorConfig | undefined,
    @inject(MongoBindings.CONNECTION_MANAGER)
    private manager: MongoConnectionManager,
  ) {}

  value(): juggler.DataSource {
    return new MongoDataSource(this.config ?? {}, this.manager);
  }
}
```

Rules:

- Providers are stateless except for injected dependencies. No mutable instance state, no caching inside the provider — caching is the job of the binding scope (`SINGLETON`).
- `value()` is synchronous when possible. Use `async value()` only when the bound value genuinely requires async construction.
- One provider per file. Name matches the binding it serves with a `Provider` suffix: `MongoDataSourceProvider` provides `MongoBindings.DATASOURCE`.
- Providers live in the folder of the artifact they construct (`datasources/` for a datasource provider), or in `providers/` if they cross artifact boundaries.

## 6. Component pattern

A plugin's entry point is a `Component` class. It declares everything the plugin contributes:

```typescript
export class MongoComponent implements Component {
  readonly bindings: Binding<unknown>[] = [
    Binding.bind(MongoBindings.CONNECTION_MANAGER)
      .toProvider(ConnectionManagerProvider)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(MongoBindings.SERVICE)
      .toClass(MongoServiceImpl)
      .inScope(BindingScope.SINGLETON),
    Binding.bind(MongoBindings.DATASOURCE)
      .toProvider(MongoDataSourceProvider)
      .inScope(BindingScope.SINGLETON),
  ];

  readonly lifeCycleObservers: Constructor<LifeCycleObserver>[] = [
    MongoLifecycleObserver,
  ];
}
```

Rules:

- A component declares only: `bindings`, `lifeCycleObservers`, `providers`, `controllers`, `servers`, `services`, `models`. Anything else belongs in a helper.
- All declarations are `readonly` instance fields. Do not mutate them post-construction.
- Default binding scope is `SINGLETON`. Use `BindingScope.TRANSIENT` or `REQUEST` only when justified in a `// Why:` comment.
- Components must not bind config. The application binds `MyPluginBindings.CONFIG`; the component reads it via `@inject(..., {optional: true})` inside its providers. Why: config is the application's contract with the plugin; the component should not assume defaults beyond a documented optional fallback.
- A plugin ships exactly one `*.component.ts` file at `src/`. Sub-components are an anti-pattern unless the plugin explicitly composes multiple independent capabilities.
- The component class is `@public`. Its providers and lifecycle observers are `@internal` unless re-exported intentionally.

## 7. Lifecycle observers

Anything that opens I/O — database connections, message queues, file watchers, websockets, scheduled timers — runs behind a `@lifeCycleObserver` class:

```typescript
@lifeCycleObserver('mongodb')
export class MongoLifecycleObserver implements LifeCycleObserver {
  constructor(
    @inject(MongoBindings.CONNECTION_MANAGER)
    private manager: MongoConnectionManager,
  ) {}

  async start(): Promise<void> {
    await this.manager.connect();
  }

  async stop(): Promise<void> {
    await this.manager.disconnect();
  }
}
```

Rules:

- Both `start()` and `stop()` must be idempotent. Calling `start` twice must not open two connections; calling `stop` twice must not throw. The framework calls them more than once in some tests and hot-reload scenarios.
- `stop()` must succeed even if `start()` failed or was never called. Treat partially-initialized state as the normal case.
- The observer group string (the argument to `@lifeCycleObserver`) is the plugin's binding namespace prefix. Why: makes ordering and selective shutdown trivial in larger apps.
- Lifecycle observers must not own business logic. They wrap a resource manager (see Shared resource ownership).
- Observers are registered through the component's `lifeCycleObservers` array, not through standalone `@bind` decorators.

## 8. Shared resource ownership

A plugin that constructs an artifact against a shared resource — a connection manager, an HTTP client pool, an open file — must track whether it owns the resource and skip cleanup when it does not:

```typescript
export class MongoConnector {
  private connectionManager: MongoConnectionManager;
  private readonly ownsConnectionManager: boolean;

  constructor(
    settings: MongoConnectorConfig,
    connectionManager?: MongoConnectionManager,
  ) {
    if (connectionManager) {
      this.connectionManager = connectionManager;
      this.ownsConnectionManager = false;
    } else {
      this.connectionManager = new MongoConnectionManager(settings);
      this.ownsConnectionManager = true;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.ownsConnectionManager) return; // shared; not ours
    await this.connectionManager.disconnect();
  }
}
```

Rules:

- The ownership flag is `readonly` and set exactly once in the constructor.
- The flag is named `owns<Resource>`. Boolean, no negations.
- Construction that injects a shared resource sets `owns = false`. Construction that fabricates the resource locally sets `owns = true`.
- `stop()` / `disconnect()` / `close()` is the only place ownership is consulted. CRUD paths must work identically regardless of ownership.
- When both modes ship in one class, the constructor JSDoc must spell out the ownership contract for each call shape.

Why: without explicit ownership, a connector wrapped by a component closes the pool the component still needs, or the component double-closes a pool the connector already closed. Both manifest as flaky tests.

## 9. Stability tags

Every exported symbol gets exactly one stability tag in its JSDoc: `@public`, `@experimental`, or `@internal`.

```typescript
/**
 * Shared MongoDB connection manager.
 *
 * @public
 */
export class MongoConnectionManager {
  /* ... */
}

/**
 * @experimental
 */
export function detectTopology(client: MongoClient): TopologyInfo {
  /* ... */
}

/**
 * @internal
 */
export function parseOptionsCallback(/* ... */) {
  /* ... */
}
```

Rules:

- `@public`: a semver commitment. Breaking changes require a major version bump and CHANGELOG entry.
- `@experimental`: shipped, documented, but the signature may break in a minor. Default tag for newly added exports.
- `@internal`: not part of the package's API surface. Excluded from generated docs. Consumers reaching for it accept breakage at any time.
- A symbol with no tag is treated as `@internal` by tooling but must not exist in code review — every export carries a tag.
- API Extractor (or equivalent) is the source of truth for what's in the public surface; tags drive its report. CI fails if the report drifts without an accompanying version bump.

## 10. Peer dependencies

LoopBack core packages are peer dependencies with a bounded major range:

```json
{
  "peerDependencies": {
    "@loopback/core": ">=7.0.0 <8.0.0",
    "@loopback/repository": ">=8.0.0 <9.0.0"
  }
}
```

Rules:

- Use `>=X.0.0 <(X+1).0.0`, not `^X.0.0`. The `^` range is fine for caret-aware tools but ambiguous in peer-dependency error messages; the explicit form removes the ambiguity.
- `@loopback/*` versions do NOT match across packages. `@loopback/repository@8.x` pairs with `@loopback/core@7.x`. Verify the pairing in the target LoopBack release notes before bumping. Do not assume the version numbers align.
- Driver-level runtime dependencies (`mongodb`, `pg`, `ioredis`, `redis`) are caret-pinned `dependencies`, not peers. Why: there is exactly one driver per process; the plugin owns the version, not the consumer.
- Dev-time copies of every peer go in `devDependencies` so the plugin compiles and tests against a known pair. Keep the dev copy inside the declared peer range.
- `engines.node` declares the supported Node major(s) explicitly. CI matrix mirrors it.

## 11. Test layout

```
src/
  __tests__/
    unit/
      query-builder.spec.ts
      config-validator.spec.ts
    integration/
      connector.spec.ts
      service.spec.ts
```

Rules:

- `unit/`: pure logic. No I/O, no timers, no globals. Each file targets one source module.
- `integration/`: anything that touches I/O. Uses a real backing service — `mongodb-memory-server`, `pg-mem`, ephemeral Docker containers, in-memory queues with the real client. Never mocks of the driver itself. Why: driver mocks encode the test author's assumptions about the driver, not the driver's actual behavior; the bugs that matter live in that gap.
- Recommended runner: Vitest. The `vitest.config.ts` for integration must pin `singleThread: true`:

```typescript
export default defineConfig({
  test: {
    pool: 'threads',
    poolOptions: {threads: {singleThread: true}},
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
```

Why: memory-server style backends spin up a real server per test file; parallel files saturate CPU and make time-sensitive assertions (Change Streams, replication lag, debounce) flake.

- Test files end in `.spec.ts`. Use `.test.ts` only if migrating an existing codebase.
- One `describe` per public method or behavior. Test names start with a verb: `'reconnects after disconnect'`, not `'should reconnect'`.
- Setup that opens I/O lives in `beforeAll`; setup that resets state lives in `beforeEach`. Never open a connection in `beforeEach`.
- CI runs unit and integration as separate jobs, on a Node version matrix covering every supported major declared in `engines.node`.

## 12. JSDoc conventions

Multi-line JSDoc on every exported symbol. Single-line `/** ... */` is reserved for trivial getters.

Tag order is fixed:

1. Stability tag: `@public`, `@experimental`, `@internal`.
2. `@param` (one per parameter, in declaration order).
3. `@returns`.
4. `@throws` (one per distinct error type).
5. `@see`, `@example` last.

```typescript
/**
 * Connect to MongoDB. Idempotent and concurrency-safe.
 *
 * Concurrent calls share the same in-flight connect promise. If a
 * disconnect is in progress, awaits it before opening a new client.
 *
 * @public
 * @param options - Optional client overrides; merged over the
 *   constructor settings. See `MongoBindings.CONFIG`.
 * @returns Resolves when the client is connected and the default
 *   database handle is cached.
 * @throws MongoConfigError When config is missing or malformed.
 */
async connect(options?: ConnectOptions): Promise<void> { /* ... */ }
```

Rules:

- Cross-link binding keys with backtick names: `` `MongoBindings.CONFIG` ``. Do not hyperlink them.
- Never use HTML tags inside JSDoc. No `<br>`, `<p>`, `<code>`. Use Markdown paragraphs and backticks.
- Sentences end with periods. Imperative mood for behavior descriptions ("Connect to MongoDB.", not "Connects to MongoDB.").
- No `@author`, `@version`, `@since` — release-please owns versions and authorship lives in git.
- Internal helpers (non-exported) get a one-line JSDoc only if their name is not self-explanatory.

## 13. Error handling

Throw `Error` subclasses, never plain objects, strings, or `Error` itself when a domain class is appropriate:

```typescript
export class MongoConfigError extends Error {
  override readonly name = 'MongoConfigError';
  constructor(message: string) {
    super(message);
  }
}
```

Rules:

- Error class name is `<Domain><Kind>Error` — `MongoConfigError`, `AuthTokenError`, `RedisConnectionError`. The `name` field is set to match the class name with `override readonly`.
- One error class per failure category, not one per call site. A `MongoConfigError` covers every config-validation failure.
- Error messages are user-readable and actionable. They name the offending field and suggest the fix.
- Never leak credentials. Redact at the boundary that constructs the message, not at the log sink:

```typescript
throw new MongoConfigError(
  `MongoDB url scheme must be mongodb:// or mongodb+srv://, ` +
    `got "${parsed.protocol}" in ${redactUrl(config.url)}`,
);
```

- Driver-originated errors pass through unchanged. Do not wrap them — wrapping hides the driver's error code, which consumers match on.
- `try` / `catch` only when adding context or recovering. Naked `catch (err) { throw err; }` is forbidden.
- Async functions throw; they do not return `{error, result}` tuples.
- **Retry only what is worth retrying.** DO retry: transient network errors, timeouts, HTTP 429, and 5xx server errors. DO NOT retry: 4xx client errors — those indicate a bug or invalid input, and retrying masks the root cause and wastes time. Surface 4xx to the caller immediately.
- **Cleanup is wrapped in its own `try` / `catch`** so a failure during teardown does not mask the original error. The original error always wins:

```typescript
try {
  await doWork(session);
} catch (err) {
  try {
    await session.abortTransaction();
    await session.endSession();
  } catch (cleanupErr) {
    debug('cleanup failed after primary error: %O', cleanupErr);
  }
  throw err;
}
```

## 14. Config validation

Plugins validate config at the framework boundary — at component bind time or at the first lifecycle entry — not deep inside a driver call. The driver's errors are good for driver-shape issues (auth, TLS, server reachability); they are terrible for "you forgot to set the url".

```typescript
export function validateConfig(config: MongoConnectorConfig | undefined): void {
  if (!config) {
    throw new MongoConfigError(
      'MongoDB config is missing. Bind MongoBindings.CONFIG or ' +
        'pass settings to the DataSource.',
    );
  }
  if (!config.url && !config.host) {
    throw new MongoConfigError(
      'MongoDB config requires either `url` or `host`. Got neither.',
    );
  }
  // delegate URL/auth/TLS shape to the driver
}
```

Rules:

- Validate only the fields the framework needs to even hand the call to the driver: presence of required fields, parseable shapes, supported enum values. Anything the driver would reject with a clear message is the driver's job.
- Throw the plugin's typed `<Domain>ConfigError`, never `TypeError` or `Error`.
- Redact credentials in every error message. Use a shared `redactUrl` / `redactConfig` helper.
- Validation lives in `helpers/config-validator.ts`. The lifecycle observer or provider calls it; controllers and services do not duplicate it.
- The validator is pure and synchronous. Async validation (DNS lookups, server probes) belongs in the lifecycle observer's `start()`, not in `validateConfig`.

## 15. Type system

Adopt Google's TypeScript type rules. The LoopBack-specific points:

- No `any`. Use `unknown` for genuinely opaque values and narrow at the boundary. Why: LoopBack's juggler layer is loosely typed; `any` lets that looseness leak through every layer of your plugin.
- `as` casts only. No `<T>` cast syntax — collides with JSX and reads worse in arrow generics.
- Prefer `?` optional fields over `field: T | undefined` unions in interfaces. Use the union form only when the field is required-but-nullable.
- `import type { Foo }` for every type-only import. This is enforced by `verbatimModuleSyntax`. It matters more than usual because `keys.ts` is at the center of the import graph; runtime imports there create cycles.
- `readonly` on every field that is set in the constructor and never reassigned. `readonly` on every array/object property exposed publicly.
- Discriminated unions over enum-of-flags. `type State = 'connecting' | 'connected' | 'disconnecting' | 'disconnected'`.
- When juggler internals must be accessed (rare, last resort), use the double-cast `as unknown as { knownProp: T }` and pin the bypass with an integration test that fails if juggler renames or removes the field:

```typescript
// Driver internals: pinned by topology.spec.ts.
const topology = (
  client as unknown as {
    topology?: {description?: {type: string}};
  }
).topology;
```

Why: the framework's typed surface is the contract; everything outside it can change between minor releases. The regression test makes the implicit dependency explicit and noisy when it breaks.

## 16. Commit messages

Conventional Commits. Allowed types:

- `feat` — user-visible feature.
- `fix` — bug fix.
- `docs` — documentation only.
- `chore` — repo plumbing.
- `ci` — CI configuration.
- `build` — build system, packaging.
- `deps` — dependency bumps.
- `perf` — performance, no behavior change.
- `refactor` — refactor with no behavior change.
- `revert` — revert of an earlier commit.
- `style` — formatting only.
- `test` — tests only.

Format:

```
<type>(<scope>): <subject>

<body>

<footers>
```

Rules:

- Scope is optional but encouraged. Use the artifact suffix: `feat(connector): support transactions`.
- Subject is imperative, lowercase first letter, no trailing period.
- Body wraps at 72 columns, explains the why.
- `BREAKING CHANGE:` footer on any change that breaks a `@public` symbol; release-please bumps the major.
- DCO sign-off required: `git commit -s`. PRs without `Signed-off-by:` fail CI.
- Commitlint enforces the format. Configure it in `commitlint.config.js` extending `@commitlint/config-conventional`.

## 17. Release engineering

release-please owns versioning and CHANGELOG generation.

Rules:

- Source `package.json` ships `"version": "0.0.0"`. The release bot rewrites it on the release branch. Why: the source-of-truth version lives in the release tag, not in a file humans can drift.
- A `release-please-config.json` at the repo root pins the release strategy (`node`), the changelog sections, and the package path.
- CHANGELOG.md is generated, never hand-edited. Entries come from Conventional Commit subjects; `feat` and `fix` show up automatically, other types only if explicitly configured.
- The release PR is the only commit that touches `version`, `CHANGELOG.md`, and the lockfile in concert. Maintainers approve and merge it; merging tags and publishes.
- npm publish is performed by CI, not by humans. The CI job needs `NPM_TOKEN` and runs `npm publish` only on the release commit.
- Pre-1.0 plugins can mark every `@public` change as `BREAKING CHANGE` for the duration; this is the cleanest way to communicate that the surface is still unstable.
- Generated artifacts (`dist/`, `*.d.ts`) are not committed. The `files` array in `package.json` controls what gets published.

## 18. Performance

These are baseline expectations, not optimizations. They prevent the obvious traps.

- **No I/O inside loops.** Batch the work, then issue one I/O call:

```typescript
// Bug: one round trip per item.
for (const item of items) {
  await collection.insertOne(item);
}

// Fix: one round trip total.
await collection.insertMany(items);
```

Same rule for HTTP calls, file reads, child-process spawns, and any per-iteration driver invocation. If the data set is too large to fit in one batch, page through it with explicit batch boundaries (`bulkWrite` with ordered batches, cursor `next()` loops with `batchSize`), not implicit per-item `await`s.
