# @ebarahona/loopback-contracts

[![npm version](https://img.shields.io/npm/v/@ebarahona/loopback-contracts.svg)](https://www.npmjs.com/package/@ebarahona/loopback-contracts)
[![CI](https://img.shields.io/github/actions/workflow/status/ebarahona/loopback-contracts/ci.yml?branch=main&label=ci)](https://github.com/ebarahona/loopback-contracts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@ebarahona/loopback-contracts.svg)](./LICENSE)

JSON Schema-driven contract substrate for LoopBack 4. The user authors pure JSON Schema 2020-12 (no vendor extensions) plus a sibling LB-isms config; the engine emits idiomatic LB4 `@model` / `@repository` / `@controller` / datasource classes plus nine opt-in sidecar projections. Six extension-point tags keep the engine and the emitters strictly separated; new formats and new schema sources arrive as plugins without engine changes.

```bash
npm install @ebarahona/loopback-contracts
```

> Part of the [`@ebarahona/loopback-*` plugin portfolio](https://github.com/ebarahona/loopback-plugins). The sibling [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import) covers the inverse direction (Zod / OpenAPI / WSDL / Avro / proto / GraphQL SDL / AsyncAPI / live database → `schemas/*.schema.json`); the two plugins are mirror operations on either side of the canonical schema substrate.

## Why this exists

LoopBack 4 traded LoopBack 3's JSON-driven authoring ergonomics for a TypeScript-first surface. A significant population of LB3 shops never migrated for that exact reason. `loopback-contracts` restores the LB3 workflow — but expressed in **JSON Schema 2020-12** instead of LB3's bespoke `models/*.json` DSL, with all the editor support, validation tooling, and cross-language portability that brings.

Every LB3 muscle-memory action has a 1:1 successor. Every JSON file is standards-validated. The TypeScript surface is generated. LB4's type system and DI container work as advertised because the codegen emits idiomatic LB4 code.

The full architectural rationale lives in [`loopback-contracts.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/loopback-contracts.md); the extensibility architecture lives in [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md). This README is the operating manual.

## Installation

```bash
npm install @ebarahona/loopback-contracts
```

Peer dependencies (declared but installed by the consumer):

```json
{
  "peerDependencies": {
    "@loopback/core": ">=7.0.0 <8.0.0",
    "@loopback/repository": ">=8.0.0 <9.0.0",
    "@loopback/rest": ">=15.0.0 <16.0.0"
  }
}
```

Sidecar emitter peer-deps are optional. The engine declares them with `peerDependenciesMeta.optional = true` and loads each one lazily on the first emit, so a consumer that only enables `--emit-zod` does not need `quicktype-core` (proto, Avro, GraphQL SDL), the `cloudevents` package, `json-schema-faker`, or any of the other format-specific libraries:

| Flag                        | Optional peer-deps              |
| --------------------------- | ------------------------------- |
| `--emit-zod`                | `zod`, `json-schema-to-zod`     |
| `--emit-types`              | `json-schema-to-typescript`     |
| `--emit-graphql`            | `quicktype-core` (only for SDL) |
| `--emit-cloudevents`        | `cloudevents`                   |
| `--emit-asyncapi`           | (none — own template)           |
| `--emit-proto`              | `quicktype-core`                |
| `--emit-avro`               | `quicktype-core`                |
| `--emit-openapi-components` | (none — own template)           |
| `--emit-mock-data`          | `json-schema-faker`             |

The engine prints a clear actionable error pointing at the missing package when a flag is enabled and its peer-dep is not installed.

## Quickstart

```bash
# 1. Initialize the project (writes loopback.config.json)
lb4 init

# 2. Scaffold a contract (writes both JSON files in one session)
lb4 contract customer

# 3. Generate everything LB4 needs
lb4 gen
```

After `lb4 gen`, a default project looks like this:

```
my-app/
├── loopback.config.json
├── datasources.json
├── schemas/
│   └── customer.schema.json          # AUTHORED (pure JSON Schema 2020-12)
├── configs/
│   └── customer.config.json          # AUTHORED (LB-isms, $schema -> meta-schema)
├── _meta/                            # GENERATED (project-specific enums)
│   ├── model-config.schema.json
│   ├── datasources.schema.json
│   └── emitter-config.schema.json
└── src/
    ├── models/
    │   ├── customer.base.model.ts    # GENERATED (regen-always)
    │   └── index.ts
    ├── repositories/
    │   ├── customer.base.repository.ts
    │   └── index.ts
    ├── controllers/
    │   ├── customer.base.controller.ts
    │   └── index.ts
    └── datasources/
        ├── primary.base.datasource.ts
        └── index.ts
```

Six files per contract maximum, plus three barrels per directory. Extension files (no `.base.` suffix) are only emitted by `lb4 override <kind> <contract>`, not speculatively.

Day-2 edits happen in your editor. The `$schema` reference at the top of every authored JSON file resolves to the regenerated meta-schemas, giving VS Code autocomplete + inline validation + hover docs for every valid datasource, contract id, and relation kind. The CLI is for the cold start; the editor is for everything after.

## CLI command reference

Fifteen commands, all at v1.0. Four scaffolders (`lb4 init`, `lb4 contract`, `lb4 ds`, `lb4 override`) write once and refuse to overwrite; the rest regenerate idempotently.

| Command                             | What it does                                                                                                          | If target exists                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `lb4 init`                          | Scaffolds `loopback.config.json` (interactive: dirs, remote sources, validator, default sidecar emissions)            | Errors. Hand-edit the file to change settings.                     |
| `lb4 contract <name>`               | Scaffolds `schemas/<name>.schema.json` + `configs/<name>.config.json` (interactive)                                   | Errors. Hand-edit JSON to revise; `lb4 override` for TS extension. |
| `lb4 ds <name> --adapter <kind>`    | Scaffolds an entry in `datasources.json` (creates the file if missing)                                                | Errors on duplicate entry. Hand-edit `datasources.json` to modify. |
| `lb4 override <kind> <contract>`    | Scaffolds an extension stub (`src/<dir>/<contract>.<kind>.ts`)                                                        | Errors — already overridden. Delete and re-run to start fresh.     |
| `lb4 gen`                           | Regenerates `_meta/*.schema.json` + all `.base.*` TS files                                                            | Idempotent. Never touches authored JSON or extension TS.           |
| `lb4 gen --emit-zod`                | `gen` + emits `*.zod.ts` per schema                                                                                   | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-types`              | `gen` + emits `*.types.ts` (pure TS interface) per schema                                                             | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-graphql`            | `gen` + emits `*.graphql.ts` (code-first decorators); optional `--emit-graphql-sdl` adds `*.graphql` SDL text         | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-cloudevents`        | `gen` + emits `*.cloudevents.ts` (typed `CloudEvent<T>` wrappers)                                                     | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-asyncapi`           | `gen` + emits `*.asyncapi.yaml` (AsyncAPI 3.0 message-catalog fragments)                                              | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-proto`              | `gen` + emits `*.proto` (Protocol Buffers schema)                                                                     | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-avro`               | `gen` + emits `*.avsc` (Avro schema)                                                                                  | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-openapi-components` | `gen` + emits `*.openapi-components.yaml` (OAS 3.x components fragment)                                               | Sidecars regenerate with bases.                                    |
| `lb4 gen --emit-mock-data`          | `gen` + emits `*.mock.json` (one valid sample per schema via `json-schema-faker`)                                     | Sidecars regenerate with bases.                                    |
| `lb4 gen --watch` (alias `lb4 dev`) | Continuous regen via `chokidar`; respects whichever sidecar flags are set                                             | Re-runs the right pipeline phase per file kind.                    |
| `lb4 validate`                      | Read-only Ajv pass over all authored files against `_meta/*.schema.json`; reports errors with `instancePath` pointers | No writes.                                                         |

Every emit flag has a matching `loopback.config.json` setting (`"emit": {"zod": true, "graphql": true, ...}`) so the flag becomes the default for every `lb4 gen` invocation without typing it.

`loopback-contracts` works directly with JSON Schema only — it does not import from other formats. Bringing schemas in from Zod / OpenAPI / WSDL / Avro / proto / GraphQL SDL / AsyncAPI / live databases is the job of [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import) (`lb4 import-zod`, `lb4 import-openapi`, `lb4 import-wsdl`, etc.); its commands land schemas in `schemas/*.schema.json` where `loopback-contracts` then consumes them.

## Project layout

Authored vs generated, made explicit. The `.base.` suffix is the only discriminator between regen targets and user-editable extensions.

```
my-app/
├── loopback.config.json              # AUTHORED (lb4 init, then hand-edit)
├── datasources.json                  # AUTHORED (lb4 ds + hand-edit)
├── schemas/                          # AUTHORED (lb4 contract + hand-edit)
│   └── customer.schema.json
├── configs/                          # AUTHORED (lb4 contract + hand-edit)
│   └── customer.config.json
├── _meta/                            # GENERATED — gitignore'd
│   ├── model-config.schema.json
│   ├── datasources.schema.json
│   └── emitter-config.schema.json
├── .loopback/cache/                  # GENERATED — gitignore'd (remote source cache)
├── emitters/                         # AUTHORED (manifest+template emitters — optional)
│   └── audit-envelope.emitter.json
└── src/
    ├── models/
    │   ├── customer.base.model.ts            # REGEN — every lb4 gen
    │   ├── customer.model.ts                 # ONCE  — only on lb4 override
    │   ├── customer.zod.ts                   # REGEN — --emit-zod
    │   ├── customer.types.ts                 # REGEN — --emit-types
    │   ├── customer.graphql.ts               # REGEN — --emit-graphql
    │   ├── customer.cloudevents.ts           # REGEN — --emit-cloudevents
    │   ├── customer.asyncapi.yaml            # REGEN — --emit-asyncapi
    │   ├── customer.proto                    # REGEN — --emit-proto
    │   ├── customer.avsc                     # REGEN — --emit-avro
    │   ├── customer.openapi-components.yaml  # REGEN — --emit-openapi-components
    │   ├── customer.mock.json                # REGEN — --emit-mock-data
    │   └── index.ts                          # REGEN — barrel
    ├── repositories/
    │   ├── customer.base.repository.ts       # REGEN
    │   ├── customer.repository.ts            # ONCE  — only on lb4 override
    │   └── index.ts
    ├── controllers/
    │   ├── customer.base.controller.ts       # REGEN
    │   ├── customer.controller.ts            # ONCE  — only on lb4 override
    │   └── index.ts
    └── datasources/
        ├── primary.base.datasource.ts        # REGEN
        ├── primary.datasource.ts             # ONCE  — only on lb4 override
        └── index.ts
```

Rules at a glance:

- **Authored files** (`schemas/`, `configs/`, `datasources.json`, `loopback.config.json`, `emitters/`) — scaffold-once, refuse-to-overwrite. The CLI errors on duplicate; day-2 edits are hand-edits in your editor.
- **`.base.*` files** — regen-always. The engine overwrites them on every `lb4 gen`. Never hand-edit.
- **Extension files** (no `.base.` suffix) — scaffold-once via `lb4 override`, then owned by the user. The engine refuses to overwrite them after the first emit.
- **`_meta/`** — always generated, never committed. In `.gitignore`.
- **`.loopback/cache/`** — always generated, never committed. In `.gitignore`.

## Emit flags

Nine sidecar formats, all opt-in, all v1.0. Off by default. Documentation of the underlying translation work, lossy-translation reports, and per-format extension keywords lives in [`loopback-contracts.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/loopback-contracts.md).

| Flag                        | Output suffix                                            | Tier             | Notes                                                                       |
| --------------------------- | -------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `--emit-zod`                | `*.zod.ts`                                               | Real translation | Discriminator detection, `oneOf` -> `z.discriminatedUnion`, format mapping. |
| `--emit-types`              | `*.types.ts`                                             | Convenience      | Pure TS interface — equivalent to `json-schema-to-typescript`, turnkey.     |
| `--emit-graphql`            | `*.graphql.ts` (+ `*.graphql` with `--emit-graphql-sdl`) | Real translation | Code-first decorators primary, SDL secondary. ID/scalar/nullability rules.  |
| `--emit-cloudevents`        | `*.cloudevents.ts`                                       | Real translation | Typed `CloudEvent<T>` wrappers via the `cloudevents` SDK.                   |
| `--emit-asyncapi`           | `*.asyncapi.yaml`                                        | Real translation | AsyncAPI 3.0 `components.messages` / `components.schemas` fragments.        |
| `--emit-proto`              | `*.proto`                                                | Real translation | Protocol Buffers; scalar mapping, `repeated`, `oneof`, `optional`.          |
| `--emit-avro`               | `*.avsc`                                                 | Real translation | Avro records/enums/unions/maps, logical types (date, decimal, uuid).        |
| `--emit-openapi-components` | `*.openapi-components.yaml`                              | Mechanical       | OAS 3.x `components.schemas` mounted verbatim.                              |
| `--emit-mock-data`          | `*.mock.json`                                            | Convenience      | One valid sample per schema via `json-schema-faker`.                        |

Every flag has a `loopback.config.json` counterpart so the project's default emission set is configured once and reused on every `lb4 gen`.

## Schema sources

Where do the `schemas/*.schema.json` files come from? Four built-in source kinds, plus the `SOURCE_EXTENSION_TAG` extension point for plugins.

| Source                                 | Spec format                                          | Notes                                                                      |
| -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `local`                                | `./schemas/`                                         | Default. Schemas live in the project repo.                                 |
| `npm:`                                 | `npm:@my-org/contracts@^1.2.0`                       | Installs the package and reads schemas from its `dist/schemas/` directory. |
| `git+https`                            | `git+https://github.com/my-org/contracts.git#v1.2.0` | Shallow-clones into `.loopback/cache/`, reads from the ref's checkout.     |
| `https`                                | `https://my-org.dev/contracts/customer.schema.json`  | Per-file HTTP fetch; cached under `.loopback/cache/`.                      |
| `<extension>` (e.g. `s3://`, `oci://`) | Defined by the plugin under `SOURCE_EXTENSION_TAG`   | See [HELP_WANTED.md](./HELP_WANTED.md) for the open list.                  |

Source specs are configured in `loopback.config.json` under the `sources` array; the engine resolves every spec in declaration order and merges the resulting schema set before validation.

## 8-stage validation pipeline

Every `lb4 gen` invocation walks the same eight stages in order. Failure at any stage halts the run with an actionable error pointing at the offending file and JSON pointer.

1. **Source fetch.** Resolve every source spec in `loopback.config.json` via its `SOURCE_TAG` resolver; download remote schemas into `.loopback/cache/` (with content-addressed caching); union the result into the registry.
2. **Syntactic validation.** Ajv-validates every authored schema against the JSON Schema 2020-12 meta-schema. Catches malformed schemas before any other stage sees them.
3. **Project-wide cross-reference validation.** Verify that every `$ref` resolves inside the merged registry; verify that every `configs/*.config.json` `$contractId` matches a schema `$id`; verify that every `relations.*.schema` reference points at a known contract.
4. **Meta-schema regeneration.** Re-derive `_meta/model-config.schema.json` (project-specific `$contractId`, `dataSource`, and `relations.*.schema` enums), `_meta/datasources.schema.json` (project-specific `adapter` enum from installed connector peers), and `_meta/emitter-config.schema.json` (project-specific emitter enum from every registered `EMITTER_TAG` binding).
5. **Config validation.** Ajv-validate every `configs/*.config.json` against the freshly regenerated `_meta/model-config.schema.json`. This is the gate where cross-reference typos fail loud.
6. **Emitter dispatch.** For every schema, for every enabled emitter (built-in, plugin, manifest), call `emit(EmitterContext)`. Emitters return `EmittedFile[]`; the engine collects them.
7. **File write.** Apply the regen-always / scaffold-once rules: `.base.*` files force-overwrite, extension files skip-if-exists, barrel files regenerate, `_meta/` regenerates. Lossy-translation warnings are aggregated and printed.
8. **Optional `tsc` pass.** When run in CI mode (`lb4 gen --check`), the engine invokes `tsc --noEmit` on the produced bases to verify the generated TS compiles. Off by default in dev to keep the watch loop sub-second.

`--strict` promotes every lossy-translation warning at stage 6 to an error, halting the run before stage 7. Useful in CI where any silent approximation is a build failure.

## Extension points

Six extension-point tags. All stable at v1.0. Plugins register bindings under the appropriate tag and the engine resolves them via LB4's native `@extensions.list({tag: ...})` mechanism — the same pattern `@loopback/authentication` uses for strategies and `@loopback/boot` uses for booters.

| Tag                           | What it extends                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMITTER_TAG`                 | Add a new `ProjectionEmitter` for a not-yet-covered output format. CLI auto-accepts `--emit-<kind>`; `lb4 init` auto-shows the option.      |
| `SOURCE_TAG`                  | The four built-in source kinds (`local`, `npm:`, `git+https`, `https`) all bind under this tag.                                             |
| `SOURCE_EXTENSION_TAG`        | Contribute a new source kind (`s3://`, `oci://`, etc.) without touching the built-in resolvers.                                             |
| `EXTENSION_KEYWORD_TAG`       | Register a handler for an `x-*` keyword in source schemas (e.g. `x-graphql`, `x-emit-skip`). The engine routes the keyword to your handler. |
| `META_SCHEMA_CONTRIBUTOR_TAG` | Contribute additional enums to the generated `_meta/*.schema.json` files (e.g. plugin-specific adapter kinds, valid emitter options).       |
| `VALIDATOR_TAG`               | Register additional Ajv formats (`phone`, `objectid`, org-internal formats) and keywords used by source schemas.                            |

Auto-integration is the architectural guarantee: when an emitter binding appears under `EMITTER_TAG`, the CLI flag parser, `lb4 init` prompts, and meta-schema generator all pick it up automatically. No emitter author edits the CLI, the prompt machinery, or the meta-schema generator.

Full reference (interface contracts, lifecycle, versioning policy, comprehensive examples for both contribution paths): [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md).

## Two emitter contribution paths

| Path                    | When to use                                                                                          | What the author ships                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Code-based plugin**   | Real translation work — Zod-like, GraphQL-like, anything needing libraries or programmatic traversal | npm package with `@injectable({tags: {EMITTER_TAG, kind}})` class implementing `ProjectionEmitter`. |
| **Manifest + template** | Mechanical projections — project-local event wrappers, internal envelopes, custom format mirrors     | `emitters/<name>.emitter.json` + EJS template under the project root. No TS code, no npm publish.   |

Both paths register through the same `EMITTER_TAG` binding and follow the same `ProjectionEmitter` lifecycle. The manifest path is intentionally lower-friction: a project author with no TS publishing infrastructure can ship a new envelope-format emitter as two files committed to their own repo. The engine's `ManifestEmitterBooter` loads them at boot.

## Stability and semver

Every exported symbol carries exactly one stability tag: `@public`, `@experimental`, or `@internal`. The rules and rationale are documented in [STYLE_GUIDE.md](./STYLE_GUIDE.md) § Stability tags.

- The `ProjectionEmitter` interface, the `ContractsBindings.*` namespace, and every other symbol marked `@public` are semver-locked at v1.0. Breaking changes require a major bump and a CHANGELOG entry. The `ProjectionEmitter` interface specifically is reserved for v2.0; no v1.x release will break it.
- `@experimental` symbols ship documented but the signature may break in a minor. New exports default to `@experimental` until at least one real consumer has exercised the surface, then promote to `@public` in a separate PR.
- `@internal` symbols are not part of the package's API. They are excluded from generated TypeDoc; consumers reaching for them accept breakage at any time.
- API Extractor (or equivalent) is the source of truth for what is in the public surface; the report drives CI. Surface drift without an accompanying version bump fails CI.

## Requirements

- Node.js >= 20.19.0
- A LoopBack 4 application (or any TypeScript project; the generated bases compile on their own and only need `@loopback/core` + `@loopback/repository` at runtime).

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the local setup, the `lint && build && test` gate, the git-hook setup, and the PR expectations. AI-coding-agent contributors should read [AGENTS.md](./AGENTS.md) and [STYLE_GUIDE.md](./STYLE_GUIDE.md) before writing code. Open contribution slots — new emitters, new source resolvers, fixture schemas, manifest-emitter templates — are listed in [HELP_WANTED.md](./HELP_WANTED.md).

## Documentation

- API reference (generated by TypeDoc on every release): https://ebarahona.github.io/loopback-contracts
- Architectural reference: [`loopback-contracts.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/loopback-contracts.md)
- Extensibility reference: [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md)
- Sibling plugin for the inverse direction: [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import)
- Roadmap: [ROADMAP.md](./ROADMAP.md)

## License

MIT
