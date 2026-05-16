---
name: lb4-plugin-review
description: Reusable code review skill for any LoopBack 4 plugin (component, connector, extension, transport). Universal plugin-author rubric plus a parameterized domain-specific rubric. Prompts for the plugin's domain (e.g. mongodb, rxjs, kafka) and a canonical docs URL, then fetches those docs to apply domain pitfalls on top of the universal rubric. References the upstream `loopback-core` skill for framework patterns.
---

# lb4-plugin-review

Drop-in code-review skill for any LoopBack 4 plugin. Two layers:

1. **Universal LB4 plugin-author rubric** — always applies.
2. **Domain-specific rubric** — parameterized by `{SKILL_DOMAIN}` and `{DOMAIN_DOCS_URL}` supplied by the user at invocation. Optional — skip if the plugin has no driver / SDK dependency worth auditing.

Wherever this file says `{SKILL_DOMAIN}`, substitute the user's answer (e.g. `mongodb`, `rxjs`, `kafka`, `redis`, `stripe`, `aws-sdk`). Wherever it says `{DOMAIN_DOCS_URL}`, substitute the user's URL.

## Stage 0 — Prompt (run once per invocation)

Ask the contributor three questions before reading any code:

1. **`{SKILL_DOMAIN}`** — short kebab-case label for the driver / SDK this plugin wraps. Examples: `mongodb`, `rxjs`, `kafka`, `amqp`, `mqtt`, `nats`, `grpc`, `redis`, `postgres`, `mysql`, `stripe`, `aws-sdk`, `auth`, `socketio`. Use `none` if the plugin is pure framework code with no external driver.
2. **`{DOMAIN_DOCS_URL}`** — canonical upstream docs URL for that domain. Examples:
   - mongodb → `https://www.mongodb.com/docs/drivers/node/current/`
   - rxjs → `https://rxjs.dev/`
   - kafka → `https://kafka.js.org/docs/getting-started`
   - amqp → `https://amqp-node.github.io/amqplib/`
   - mqtt → `https://github.com/mqttjs/MQTT.js`
   - nats → `https://docs.nats.io/using-nats/developer`
   - grpc → `https://grpc.io/docs/languages/node/`
   - redis → `https://redis.io/docs/clients/nodejs/`
   - stripe → `https://docs.stripe.com/api`

   If `{SKILL_DOMAIN}` is `none`, no URL needed.

3. **Baseline ref** — what to diff against. Default `origin/main`. If `origin/main` is local-only ahead of remote, use the latest tag.

If the answers are missing, ask. Don't guess. Pass `none` only when the plugin has zero external driver surface.

If `{SKILL_DOMAIN}` is not `none`, use the `WebFetch` tool against `{DOMAIN_DOCS_URL}` with the prompt:

> "Extract the top 10 production pitfalls when integrating this driver/SDK in a Node.js library: resource lifecycle, retry semantics, error categories, credential leakage, breaking changes between versions, hot-path performance. Return concrete bulleted rules with file/symbol references when possible. 300 words max."

Use the returned bullets as the `{SKILL_DOMAIN}` rubric in Stage 3.

## Stage 1 — Read

```bash
git diff <baseline>..HEAD --stat
git diff <baseline>..HEAD
git diff             # uncommitted
git log <baseline>..HEAD --oneline
```

Then read:

- Every file in the diff.
- `STYLE_GUIDE.md` if it exists in the plugin repo.
- `src/index.ts` (current public surface).
- `CONTRIBUTING.md` (process expectations).
- LoopBack's [`loopback-core` skill](https://github.com/loopbackio/loopback-next/tree/master/skills/loopback-core) and its `references/` whenever the diff touches IoC / DI / extension points / interceptors / lifecycle observers / components. Use it as the canonical framework reference and flag deviations.

## Stage 2 — Universal LB4 plugin-author rubric (always applies)

### Architecture & plugin patterns

- New capabilities are added as plugins (Component, Provider, Service), not by modifying engine internals.
- New `BindingKey` entries are typed (`BindingKey.create<T>(...)`), namespaced under the plugin's `Bindings` namespace, exported from `keys.ts`.
- New singletons bound `inScope(BindingScope.SINGLETON)`.
- Anything that opens I/O lives behind a `@lifeCycleObserver('group')` class with idempotent `start()` / `stop()`. Concurrent `start` must coalesce via a shared in-flight promise; `stop` mid-`start` must be safe (state machine or generation counter).
- Shared resources (connection managers, client pools, file watchers) track ownership with a flag and skip teardown when not owner.

### Public API hygiene

- Every new export from `src/index.ts` has a JSDoc block with one of `@public`, `@experimental`, `@internal`. Default for new exports is `@experimental`.
- `export type` for type-only re-exports.
- No internal types leaking into public surface (follow generics + return types; confirm each is itself exported or built-in).

### Type system & casts

- No `any`. `unknown` is fine.
- `as unknown as { ... }` casts have an explanatory comment naming the upstream contract relied on. Bonus: a regression test pins that contract.
- `@ts-expect-error` includes a description; `@ts-ignore` rejected.

### Tests

- New behavior has at least one test. Unit tests under `src/__tests__/unit/`, integration tests under `src/__tests__/integration/` with real backing services, not mocks.
- Bug fixes carry a regression test that fails on the pre-fix code.

### Error handling

- Thrown errors are subclasses named `<Domain>Error` (where `<Domain>` matches `{SKILL_DOMAIN}` or the plugin's own domain), not raw `Error`.
- No credentials in error messages; values that could contain them go through a `redactXxx()` helper.
- Cleanup wrapped in its own try/catch so failures don't mask the original error.

### Config validation

- New config fields validated at the framework boundary, not inside a driver call. Throw a typed `<Domain>ConfigError` with redacted values.

## Stage 3 — `{SKILL_DOMAIN}`-specific rubric (skip if `{SKILL_DOMAIN}` is `none`)

Apply the top-10 pitfalls returned by the `WebFetch` against `{DOMAIN_DOCS_URL}`. In addition, apply these cross-cutting `{SKILL_DOMAIN}` rules that hold for almost any external driver:

- **Resource lifecycle.** Every driver client / cursor / stream / subscription opened during the diff has a documented close path on plugin shutdown. Long-lived handles (cursors, change streams, broker consumers) are tracked in a `Set` so the lifecycle observer can drain them. `Promise.allSettled` on the close loop so one slow handle doesn't block the rest.
- **Retry semantics.** Retry only what's worth retrying: transient network errors, timeouts, HTTP 429, 5xx. Never retry 4xx — those indicate a bug or invalid input and retrying masks the root cause.
- **Credential redaction.** Connection strings / tokens / API keys go through a redaction helper before any `debug()`, `console.log`, or thrown error message. The redaction must handle credentials containing reserved characters (e.g. literal `@` in passwords) — verify via URL parser, not regex.
- **Version compatibility.** If the diff touches driver API, verify it matches the peer-dep range in `package.json`. New APIs may not exist on older driver majors; deprecated APIs may have been removed.
- **Hot-path allocation.** Per-request `pipe(map, filter, map)` chains, fresh regex compilation, fresh JSON parse — flag if inside the per-message hot path.
- **Type narrowing.** When the driver returns `T | undefined` or `T | null`, the diff must narrow before access. `(await client.find(...))!.foo` is the most common silent NPE source.

Plus whatever the doc-fetch returned. Cite `{DOMAIN_DOCS_URL}` in each finding.

## Stage 4 — Output

```
## Critical
1. src/path/file.ts:LINE — <issue> — <fix>
   Ref: <doc URL if applicable>

## Medium
2. ...

## Low
3. ...

## Resolved since last review
- <if applicable>

## Verification
- `npm run lint`
- `npm run build`
- `npm run test`
- Re-run `lb4-style-check` and `lb4-public-api-audit` on the same diff.

## Inputs used
- `{SKILL_DOMAIN}`: <value>
- `{DOMAIN_DOCS_URL}`: <value or "n/a">
- Baseline: <ref>
```

## Severity guide

- **Critical**: race condition, data loss risk, credential leak, public API surface change without semver, lifecycle correctness bug, unbounded resource leak.
- **Medium**: missing ownership flag, missing stability tag on a new export, missing regression test for a bug fix, deep cast without a contract comment, broker reconnect without bound, subscription leak.
- **Low**: minor JSDoc gap, naming inconsistency, docstring drift, low-impact dead code, hot-path operator allocation.

## Do not

- Do not modify code. Findings only.
- Do not duplicate `lb4-style-check` mechanical findings.
- Do not opine on commit message format — that's `pre-pr-check` / `conventional-commit`.
- Do not skip Stage 0. Without `{SKILL_DOMAIN}` + `{DOMAIN_DOCS_URL}`, the review is incomplete for any plugin with a real driver dependency.
- Do not invent a `{DOMAIN_DOCS_URL}` if the user can't supply one. Ask. If they truly don't know, default to the relevant npm package's README (`https://www.npmjs.com/package/<pkg>`).
