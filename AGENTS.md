# AGENTS.md

This file is read by AI coding agents (Claude Code, Codex CLI, Gemini CLI,
Cursor, Cline, Continue, Aider, etc.) per the https://agents.md/
convention. It applies to every agent regardless of which tool the
contributor is using.

## Project at a glance

`@ebarahona/loopback-contracts` is a JSON Schema-driven contract
substrate for LoopBack 4. The user authors `schemas/*.schema.json` (pure
JSON Schema 2020-12) and `configs/*.config.json` (LB-isms, datasource,
relations, ACLs, hidden fields); the engine emits LB4
`@model` / `@repository` / `@controller` / `@lifeCycleObserver`
datasource classes plus nine opt-in sidecar formats (Zod, pure TS
interfaces, GraphQL code-first + SDL, CloudEvents, AsyncAPI 3.0,
Protocol Buffers, Avro, OpenAPI components, mock fixtures). The CLI
surface is 15 commands. The architecture is an **engine + emitter
split** with six extension points (`EMITTER_TAG`, `SOURCE_TAG`,
`SOURCE_EXTENSION_TAG`, `EXTENSION_KEYWORD_TAG`,
`META_SCHEMA_CONTRIBUTOR_TAG`, `VALIDATOR_TAG`). Runtime: Node
`>= 20.19.0`. License: MIT. Repository:
https://github.com/ebarahona/loopback-contracts.

## Required reading

Read these in full before suggesting any change.

- [./STYLE_GUIDE.md](./STYLE_GUIDE.md): file naming, folder layout,
  binding keys, provider/component/lifecycle patterns, shared-resource
  ownership, stability tags, peer-dependency policy, test layout, JSDoc
  rules, error handling, config validation, type-system rules, commit
  format, release engineering.
- [./CONTRIBUTING.md](./CONTRIBUTING.md): local setup, the
  `lint && build && test` gate, git hook paths (lefthook vs
  `.githooks`), PR expectations, release-please flow, bug-report
  requirements.
- [`loopback-contracts.md` design doc](/Users/ed/dev/oss/loopback-plugins/docs/loopback-contracts.md):
  authored vs generated file kinds, the eight-stage validation
  pipeline, the 15 CLI commands, every sidecar emitter, the watch-mode
  loop, the schema-as-source principle.
- [`contracts-extensibility.md` design doc](/Users/ed/dev/oss/loopback-plugins/docs/contracts-extensibility.md):
  the `ProjectionEmitter` interface contract, the six extension-point
  tags, code-plugin vs manifest+template contribution paths,
  auto-integration with the CLI and meta-schemas, engine-vs-emitter
  split, versioning policy.
- LoopBack's official [`loopback-core` skill](https://github.com/loopbackio/loopback-next/tree/master/skills/loopback-core)
  , upstream reference for IoC, dependency injection, extension points,
  interceptors, lifecycle observers, and components. Defer to this for
  framework patterns; STYLE_GUIDE.md only documents plugin-author
  conventions layered on top.

## Workflow expectations

1. Every commit uses Conventional Commits. Allowed types: `feat`,
   `fix`, `docs`, `chore`, `ci`, `build`, `deps`, `perf`, `refactor`,
   `revert`, `style`, `test`, release-please derives `CHANGELOG.md` and
   the version bump from these. Incorrect types silently break the
   release.
2. Every commit carries a DCO sign-off (`git commit -s`). PRs without
   `Signed-off-by:` fail CI.
3. `npm run lint && npm run build && npm test` must pass locally
   before you propose a commit. Do not propose a commit you have not
   verified.
4. Pre-commit hooks (lefthook by default, `.githooks` as the
   zero-dependency fallback) run the same checks. Never skip them with
   `--no-verify`. If a hook reformats files, re-stage the changes and
   propose the commit again. Do not amend silently.
5. Every new emitter or source resolver ships with an integration test
   under `src/__tests__/integration/` that exercises the binding tag
   end-to-end (engine run, file writer, golden-file assertion). Engine
   guarantees are validated only through the public extension surface,
   never by reaching into engine internals from a test.
6. New public exports default to `@experimental` JSDoc until at least
   one real consumer has exercised the surface; promote to `@public` in
   a separate PR.

## File-write rules

These rules are load-bearing and they are easy to get wrong. Misapplying
them silently destroys user-authored content.

- `_meta/` is **always generated**. Never commit it; the engine
  regenerates it on every `lb4 gen`. The directory is in `.gitignore`.
- `.loopback/cache/` is **always generated**. Source-resolver downloads
  land here. Never commit it; it is in `.gitignore`.
- Authored files (`schemas/*.schema.json`, `configs/*.config.json`,
  `datasources.json` entries) are **scaffold-once / refuse-to-overwrite**.
  The CLI errors if the target exists. Day-2 edits happen in the
  user's editor, never through the CLI.
- Generated base files (`src/**/*.base.*.ts`) are **regen-always**. The
  engine overwrites them on every run. Never hand-edit a `.base.` file
  , the next `lb4 gen` deletes the change. Hand-editing belongs in the
  extension file (no `.base.` suffix).
- Extension files (`src/**/*.{model,repository,controller,datasource}.ts`,
  without `.base.`) are **scaffold-once via `lb4 override`**, then owned
  by the user. The engine refuses to overwrite them after the first
  emit.

## Architecture rules

- Engine and emitters are strictly separated. The engine owns the
  pipeline, validation gates, registry, runner, template execution,
  file writer, and error reporting. Emitters implement one interface
  (`ProjectionEmitter`) and never touch engine internals. Adding a new
  emitter never requires modifying engine code.
- Six extension-point tags are stable at v1.0. Plugins self-register
  under the appropriate tag and the engine resolves them at boot:
  `EMITTER_TAG` (projection emitters), `SOURCE_TAG` (schema-source
  resolvers. `local`, `npm:`, `git+https`, `https`),
  `SOURCE_EXTENSION_TAG` (additional source kinds. `s3://`, `oci://`,
  etc.), `EXTENSION_KEYWORD_TAG` (`x-*` keyword handlers),
  `META_SCHEMA_CONTRIBUTOR_TAG` (per-emitter enum contributions to the
  generated `_meta/*.schema.json`), `VALIDATOR_TAG` (additional Ajv
  formats and keywords).
- The `ProjectionEmitter` interface is committed at v1.0 and follows
  semver. Engine internals can change between minor versions; the
  interface contract is the published API new emitters depend on.
- JSON authored files are the single source of truth. TS bases are
  always derived. Any base file can be deleted and regenerated by
  `lb4 gen`; this is a property the engine actively preserves.
- The CLI **scaffolds** authored files exactly once (refuse to
  overwrite). The engine **regenerates** derived files idempotently.
  Scaffold and regen are different code paths; do not blur them.
- Every binding flows through `ContractsBindings.*` namespace constants
  declared in `src/keys.ts` with `BindingKey.create<T>(...)`; raw
  string binding keys are forbidden.
- I/O start/stop (filesystem watchers, remote source fetches, schema
  registry warm-up) runs inside a `@lifeCycleObserver` class; both
  `start()` and `stop()` are idempotent and safe to call after a failed
  `start()`.
- TypeScript is strict and `any` is banned; an `as unknown as { ... }`
  cast across the JSON Schema boundary must carry a `// Why:` comment
  and a regression test that fails when the schema feature changes.

## Claude Code users

Skills live at `.claude/skills/`. Invoke each as a slash command.

- `/conventional-commit`: author a Conventional Commits message from
  the staged diff.
- `/lb4-plugin-review`: comprehensive PR review covering architecture,
  public API, tests.
- `/lb4-public-api-audit`: public API surface diff and stability-tag
  check.
- `/lb4-style-check`: mechanical compliance scan against STYLE_GUIDE.md.
- `/pre-pr-check`: full readiness gate before opening a PR.
- `/new-emitter`: scaffold a new `ProjectionEmitter` with binding tag,
  template, and integration test.
- `/new-source-resolver`: scaffold a new schema-source resolver under
  the `SOURCE_EXTENSION_TAG` extension point.

## Other tool users (Codex, Gemini, Cursor, Cline, Continue, Aider)

The skill files at `.claude/skills/<name>/SKILL.md` are plain Markdown.
Open the one matching your task and follow the instructions inside;
the workflow is identical regardless of how you invoke it.

If your tool has its own per-project config (Cursor's `.cursor/rules/`,
Cline's `.clinerules`, Continue's `.continuerules`, Aider's
`.aider.conf.yml`), point it at this file and
[./STYLE_GUIDE.md](./STYLE_GUIDE.md) so the conventions apply
automatically on every turn.

## What NOT to do

- Don't add `any` or `@ts-ignore` to silence a type error. Fix the
  underlying type.
- Don't modify global git config (`--global`); scope any required
  override to this repo with `--local`.
- Don't bypass pre-commit hooks with `--no-verify`.
- Don't hand-write `CHANGELOG.md` entries; release-please owns the
  file.
- Don't bump `package.json` `version` manually; release-please owns it.
- Don't commit `_meta/` or `.loopback/cache/`; both are generated and
  in `.gitignore`.
- Don't hand-edit `.base.*` files; the next `lb4 gen` deletes the
  change. Hand-edit belongs in the matching extension file (no
  `.base.` suffix).
- Don't overwrite authored JSON from the CLI; `lb4 contract` and
  `lb4 ds` refuse to overwrite an existing target by design.
- Don't add a default export anywhere in the package.
- Don't add files outside the folder structure documented in
  [./STYLE_GUIDE.md](./STYLE_GUIDE.md) § Folder structure.

## Communicating with the maintainer

- Bug reports:
  https://github.com/ebarahona/loopback-contracts/issues
  (template: `.github/ISSUE_TEMPLATE/bug_report.yml`).
- Feature requests: same URL
  (template: `.github/ISSUE_TEMPLATE/feature_request.yml`).
- Security issues:
  https://github.com/ebarahona/loopback-contracts/security/advisories/new.
  See [./SECURITY.md](./SECURITY.md).
- Code of conduct: [./CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)
  (Contributor Covenant 2.1).
