# @ebarahona/loopback-contracts

[![npm version](https://img.shields.io/npm/v/@ebarahona/loopback-contracts.svg)](https://www.npmjs.com/package/@ebarahona/loopback-contracts)
[![CI](https://img.shields.io/github/actions/workflow/status/ebarahona/loopback-contracts/ci.yml?branch=main&label=ci)](https://github.com/ebarahona/loopback-contracts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/@ebarahona/loopback-contracts.svg)](./LICENSE)

**Write JSON Schema, get a working LoopBack 4 app.** This is the LoopBack 3 "models/\*.json" workflow that LB4 dropped — reborn on a real open standard. Describe your data once in JSON Schema 2020-12; `lb-contracts gen` writes every `@model`, `@repository`, `@controller`, and datasource class for you, plus optional Zod, GraphQL, AsyncAPI, Protocol Buffers, Avro, OpenAPI, CloudEvents, and mock-data sidecars.

```bash
npm install @ebarahona/loopback-contracts
```

### Why this exists

LoopBack 3 let you describe a domain in JSON and get a working server. LoopBack 4 made you write TypeScript decorators by hand for every model, repository, and controller. A lot of LB3 shops never made the jump for exactly that reason.

This brings the JSON-first workflow back — but on **JSON Schema 2020-12**, the real open standard, not LB3's bespoke `models/*.json` DSL. Every editor already speaks JSON Schema. Every validator understands it. Every other language has tooling for it. Your contracts stop being LoopBack-specific and start being portable.

### What you write vs. what you get

You author two small JSON files per model:

```jsonc
// schemas/customer.schema.json — pure JSON Schema, portable to any tool
{
  "$id": "customer.v1",
  "type": "object",
  "properties": {
    "id":    {"type": "string"},
    "email": {"type": "string", "format": "email"},
    "name":  {"type": "string"}
  },
  "required": ["id", "email", "name"]
}

// configs/customer.config.json — the LB4-isms (datasource binding, ACLs, relations)
{
  "$contractId": "customer.v1",
  "dataSource": "primary",
  "public": true,
  "model": {"base": "Entity", "strict": true, "idProperty": "id"}
}
```

`lb-contracts gen` produces every TypeScript file your LB4 app actually needs:

```
src/models/customer.base.model.ts            # the @model class
src/repositories/customer.base.repository.ts # DefaultCrudRepository
src/controllers/customer.base.controller.ts  # REST controller (7-method CRUD)
src/datasources/primary.base.datasource.ts   # juggler datasource
```

The `.base.` files regenerate on every `lb-contracts gen` — that's the contract. Sibling extension stubs (`<name>.model.ts`, `<name>.repository.ts`, etc.) are written once and never overwritten, so any hand-customisation you add survives every regeneration. LB4's DI container, type system, and decorators all work as advertised because the generated code is exactly what an LB4 dev would have written by hand.

Enable sidecar projections via `--emit-<kind>` flags (or `loopback.config.json#/emit`):

```bash
lb-contracts gen --emit-zod --emit-graphql --emit-asyncapi
```

…and you get `customer.zod.ts`, `customer.graphql.ts`, `customer.asyncapi.yaml` alongside the LB4 classes — the same `customer.v1` schema projected into every shape your stack consumes.

> Sibling project: [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import) covers the inverse direction — Zod / OpenAPI / WSDL / Avro / proto / GraphQL SDL / AsyncAPI / live database → `schemas/*.schema.json`. The two plugins are mirror operations on either side of the canonical schema substrate.

Full architectural rationale: [`loopback-contracts.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/loopback-contracts.md). Extensibility architecture: [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md). The rest of this README is the operating manual.

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
lb-contracts init

# 2. Add a datasource (every contract is bound to one — required before
#    the wizard in step 3 will run)
lb-contracts ds primary --adapter memory

# 3. Scaffold a contract (writes both JSON files in one session, prompts
#    to bind to one of the declared datasources)
lb-contracts contract customer

# 4. Generate everything LB4 needs
lb-contracts gen
```

After `lb-contracts gen`, a default project looks like this:

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
│   ├── emitter.schema.json
│   └── loopback-config.schema.json
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

Six files per contract maximum, plus three barrels per directory. Extension files (no `.base.` suffix) are only emitted by `lb-contracts override <kind> <contract>`, not speculatively.

Day-2 edits happen in your editor. The `$schema` reference at the top of every authored JSON file resolves to the regenerated meta-schemas, giving VS Code autocomplete + inline validation + hover docs for every valid datasource, contract id, and relation kind. The CLI is for the cold start; the editor is for everything after.

## CLI command reference

Fifteen commands, all at v1.0. Four scaffolders (`lb-contracts init`, `lb-contracts contract`, `lb-contracts ds`, `lb-contracts override`) write once and refuse to overwrite; the rest regenerate idempotently.

| Command                                               | What it does                                                                                                          | If target exists                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `lb-contracts init`                                   | Scaffolds `loopback.config.json` (interactive: dirs, remote sources, validator, default sidecar emissions)            | Errors. Hand-edit the file to change settings.                              |
| `lb-contracts contract <name>`                        | Scaffolds `schemas/<name>.schema.json` + `configs/<name>.config.json` (interactive)                                   | Errors. Hand-edit JSON to revise; `lb-contracts override` for TS extension. |
| `lb-contracts ds <name> --adapter <kind>`             | Scaffolds an entry in `datasources.json` (creates the file if missing)                                                | Errors on duplicate entry. Hand-edit `datasources.json` to modify.          |
| `lb-contracts override <kind> <contract>`             | Scaffolds an extension stub (`src/<dir>/<contract>.<kind>.ts`)                                                        | Errors — already overridden. Delete and re-run to start fresh.              |
| `lb-contracts gen`                                    | Regenerates `_meta/*.schema.json` + all `.base.*` TS files                                                            | Idempotent. Never touches authored JSON or extension TS.                    |
| `lb-contracts gen --emit-zod`                         | `gen` + emits `*.zod.ts` per schema                                                                                   | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-types`                       | `gen` + emits `*.types.ts` (pure TS interface) per schema                                                             | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-graphql`                     | `gen` + emits `*.graphql.ts` (code-first decorators); optional `--emit-graphql-sdl` adds `*.graphql` SDL text         | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-cloudevents`                 | `gen` + emits `*.cloudevents.ts` (typed `CloudEvent<T>` wrappers)                                                     | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-asyncapi`                    | `gen` + emits `*.asyncapi.yaml` (AsyncAPI 3.0 message-catalog fragments)                                              | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-proto`                       | `gen` + emits `*.proto` (Protocol Buffers schema)                                                                     | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-avro`                        | `gen` + emits `*.avsc` (Avro schema)                                                                                  | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-openapi-components`          | `gen` + emits `*.openapi-components.yaml` (OAS 3.x components fragment)                                               | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-mock-data`                   | `gen` + emits `*.mock.json` (one valid sample per schema via `json-schema-faker`)                                     | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --watch` (alias `lb-contracts dev`) | Continuous regen via `chokidar`; respects whichever sidecar flags are set                                             | Re-runs the right pipeline phase per file kind.                             |
| `lb-contracts validate`                               | Read-only Ajv pass over all authored files against `_meta/*.schema.json`; reports errors with `instancePath` pointers | No writes.                                                                  |

Every emit flag has a matching `loopback.config.json` setting (`"emit": {"zod": true, "graphql": true, ...}`) so the flag becomes the default for every `lb-contracts gen` invocation without typing it.

`loopback-contracts` works directly with JSON Schema only — it does not import from other formats. Bringing schemas in from Zod / OpenAPI / WSDL / Avro / proto / GraphQL SDL / AsyncAPI / live databases is the job of [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import) (`lb4 import-zod`, `lb4 import-openapi`, `lb4 import-wsdl`, etc.); its commands land schemas in `schemas/*.schema.json` where `loopback-contracts` then consumes them.

## Project layout

Authored vs generated, made explicit. The `.base.` suffix is the only discriminator between regen targets and user-editable extensions.

```
my-app/
├── loopback.config.json              # AUTHORED (lb-contracts init, then hand-edit)
├── datasources.json                  # AUTHORED (lb-contracts ds + hand-edit)
├── schemas/                          # AUTHORED (lb-contracts contract + hand-edit)
│   └── customer.schema.json
├── configs/                          # AUTHORED (lb-contracts contract + hand-edit)
│   └── customer.config.json
├── _meta/                            # GENERATED — gitignore'd
│   ├── model-config.schema.json
│   ├── datasources.schema.json
│   ├── emitter.schema.json
│   └── loopback-config.schema.json
├── .loopback/cache/                  # GENERATED — gitignore'd (remote source cache)
├── emitters/                         # AUTHORED (manifest+template emitters — optional)
│   └── audit-envelope.emitter.json
└── src/
    ├── models/
    │   ├── customer.base.model.ts            # REGEN — every lb-contracts gen
    │   ├── customer.model.ts                 # ONCE  — only on lb-contracts override
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
    │   ├── customer.repository.ts            # ONCE  — only on lb-contracts override
    │   └── index.ts
    ├── controllers/
    │   ├── customer.base.controller.ts       # REGEN
    │   ├── customer.controller.ts            # ONCE  — only on lb-contracts override
    │   └── index.ts
    └── datasources/
        ├── primary.base.datasource.ts        # REGEN
        ├── primary.datasource.ts             # ONCE  — only on lb-contracts override
        └── index.ts
```

Rules at a glance:

- **Authored files** (`schemas/`, `configs/`, `datasources.json`, `loopback.config.json`, `emitters/`) — scaffold-once, refuse-to-overwrite. The CLI errors on duplicate; day-2 edits are hand-edits in your editor.
- **`.base.*` files** — regen-always. The engine overwrites them on every `lb-contracts gen`. Never hand-edit.
- **Extension files** (no `.base.` suffix) — scaffold-once via `lb-contracts override`, then owned by the user. The engine refuses to overwrite them after the first emit.
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

Every flag has a `loopback.config.json` counterpart so the project's default emission set is configured once and reused on every `lb-contracts gen`.

## Schema sources

Where do the `schemas/*.schema.json` files come from? Four built-in source kinds, plus the `SOURCE_TAG` extension point for plugins to contribute additional resolver schemes.

| Source                                 | Spec format                                          | Notes                                                                      |
| -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `local`                                | `./schemas/`                                         | Default. Schemas live in the project repo.                                 |
| `npm:`                                 | `npm:@my-org/contracts@^1.2.0`                       | Installs the package and reads schemas from its `dist/schemas/` directory. |
| `git+https`                            | `git+https://github.com/my-org/contracts.git#v1.2.0` | Shallow-clones into `.loopback/cache/`, reads from the ref's checkout.     |
| `https`                                | `https://my-org.dev/contracts/customer.schema.json`  | Per-file HTTP fetch; cached under `.loopback/cache/`.                      |
| `<extension>` (e.g. `s3://`, `oci://`) | Defined by the plugin under `SOURCE_TAG`             | See [HELP_WANTED.md](./HELP_WANTED.md) for the open list.                  |

Source specs are configured in `loopback.config.json` under the `sources` array; the engine resolves every spec in declaration order and merges the resulting schema set before validation.

## 8-stage validation pipeline

Every `lb-contracts gen` invocation walks the same eight stages in order. Failure at any stage halts the run with an actionable error pointing at the offending file and JSON pointer. The stage labels below match the `stage` field surfaced on thrown `ContractsPipelineError`s (e.g. `source-fetch`, `schema-validation`, `backward-compat-diff`) so a CI failure is greppable straight back to this list.

1. **Source fetch.** Resolve every source spec in `loopback.config.json` via its `SOURCE_TAG` resolver; download remote schemas into `.loopback/cache/` (with content-addressed caching); union the result into the registry.
2. **Schema validation.** Ajv-validates every fetched schema against the JSON Schema 2020-12 meta-schema; requires a non-empty top-level `$id`. Catches malformed schemas and `$id`-less documents before any other stage sees them.
3. **Dedupe.** Add every schema to the in-memory registry, keyed by `$id`. Same content silently dedupes (a schema can legitimately surface through multiple sources); a duplicate `$id` with differing content halts the run.
4. **`$ref` resolution.** Walk every schema and verify that every `$ref` resolves inside the merged registry per RFC 3986 §5.3 (base-URI tracking through nested `$id`). Remote `$ref`s (`git+`, `npm:`) are out of scope for v1.0 and fail loud.
5. **Config validation.** Re-derive `_meta/model-config.schema.json` (project-specific `$contractId`, `dataSource`, and `relations.*.schema` enums), `_meta/datasources.schema.json` (project-specific `adapter` enum from installed connector peers — discovered from `package.json` deps matching `loopback-connector-*` AND `@loopback/connector-*`), `_meta/emitter.schema.json` (project-specific emitter enum from every registered `EMITTER_TAG` binding), and `_meta/loopback-config.schema.json` (project-specific `emit.<kind>` slots from the registered emitters). Then Ajv-validate: every `configs/*.config.json` AND every inline `config-bindings[]` entry against `model-config.schema.json`; `datasources.json` against `datasources.schema.json`; AND `loopback.config.json` itself against `loopback-config.schema.json` (with the strict-kinds pass that rejects typos like `emit.zodd: true`). Cross-reference typos and unknown emit slots fail loud here — not at codegen time.
6. **Backward-compat diff.** For every schema whose source descriptor changed pin (e.g. `#v1.2.0` -> `#v1.3.0`), classify the shape delta as `additive` / `narrowing` / `breaking`. A `breaking` verdict refuses the run unless `--allow-breaking` is set or `migration-strategy.<schemaId>.mode = 'allow'` is declared in `loopback.config.json`.
7. **Codegen (emitter dispatch + file write).** For every schema, for every enabled emitter (built-in, plugin, manifest), call `emit(EmitterContext)`; collect `EmittedFile[]`; apply the regen-always / scaffold-once rules in a single atomic commit (`.base.*` files force-overwrite, extension files skip-if-exists, barrels regenerate, `_meta/` regenerates). Lossy-translation warnings are aggregated and printed.
8. **`tsc --noEmit`.** Invokes `tsc --noEmit` against the project's `tsconfig.json` to verify the generated TS compiles. Runs by default; opt out with `--skip-tsc` (used by `--dry-run` paths and faster local rerolls). No-ops cleanly when the project has no `tsconfig.json`.

`--strict` promotes every lossy-translation warning at stage 7 to an error, halting the run before any files land. Useful in CI where any silent approximation is a build failure.

## Extension points

Six extension-point tags. All stable at v1.0. Plugins register bindings under the appropriate tag and the engine resolves them via LB4's native `@extensions.list({tag: ...})` mechanism — the same pattern `@loopback/authentication` uses for strategies and `@loopback/boot` uses for booters.

| Tag                           | What it extends                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMITTER_TAG`                 | Add a new `ProjectionEmitter` for a not-yet-covered output format. CLI auto-accepts `--emit-<kind>`; `lb-contracts init` auto-shows the option.                             |
| `SOURCE_TAG`                  | Schema source resolvers — built-in (`local`, `npm:`, `git+https`, `https`) AND plugin-contributed schemes (`s3://`, `oci://`, etc.).                                        |
| `SOURCE_EXTENSION_TAG`        | Contribute import-source wizard entries to `lb-contracts contract` (e.g. Zod import, OpenAPI import). Not for adding source resolution schemes (use `SOURCE_TAG` for that). |
| `EXTENSION_KEYWORD_TAG`       | Register a handler for an `x-*` keyword in source schemas (e.g. `x-graphql`, `x-emit-skip`). The engine routes the keyword to your handler.                                 |
| `META_SCHEMA_CONTRIBUTOR_TAG` | Contribute additional enums to the generated `_meta/*.schema.json` files (e.g. plugin-specific adapter kinds, valid emitter options).                                       |
| `VALIDATOR_TAG`               | Register additional Ajv formats (`phone`, `objectid`, org-internal formats) and keywords used by source schemas.                                                            |

Auto-integration is the architectural guarantee: when an emitter binding appears under `EMITTER_TAG`, the CLI flag parser, `lb-contracts init` prompts, and meta-schema generator all pick it up automatically. No emitter author edits the CLI, the prompt machinery, or the meta-schema generator.

Full reference (interface contracts, lifecycle, versioning policy, comprehensive examples for both contribution paths): [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md).

## Two emitter contribution paths

| Path                    | When to use                                                                                          | What the author ships                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Code-based plugin**   | Real translation work — Zod-like, GraphQL-like, anything needing libraries or programmatic traversal | npm package with `@injectable({tags: {EMITTER_TAG, kind}})` class implementing `ProjectionEmitter`. |
| **Manifest + template** | Mechanical projections — project-local event wrappers, internal envelopes, custom format mirrors     | `emitters/<name>.emitter.json` + EJS template under the project root. No TS code, no npm publish.   |

Both paths register through the same `EMITTER_TAG` binding and follow the same `ProjectionEmitter` lifecycle. The manifest path is intentionally lower-friction: a project author with no TS publishing infrastructure can ship a new envelope-format emitter as two files committed to their own repo. The engine's `ManifestEmitterBooter` loads them at boot.

## Security configuration

The optional `security` block in `loopback.config.json` is a single place to harden the engine for CI / production runs. Every sub-section is independent and every field has a documented default that preserves pre-existing behaviour, so adding the block to an existing project is a no-op until at least one sub-key is set.

The block is validated against the generated `_meta/loopback-config.schema.json` at stage 5, so typos like `security.codegen.runTSC` fail loud with an `instancePath` pointer instead of silently being ignored.

```jsonc
{
  "security": {
    "http": {
      "timeoutMs": 30000, // per-request timeout in ms (mitigates slowloris)
      "maxBodyBytes": 5242880, // 5 MB response cap (mitigates memory exhaustion)
      "allowPrivateHosts": false, // forbid SSRF against private/loopback IPs
      "verifyResolvedIps": true, // re-check IP after redirects (mitigates DNS rebinding)
      "allowedHosts": [], // unset = no allowlist; set = closed egress surface
      "allowRedirects": true,
      "maxRedirects": 10,
    },
    "emitters": {
      "allowProjectManifests": true, // scan <projectRoot>/emitters/*.emitter.json
      "allowedKinds": [], // unset = every discovered kind registers
    },
    "codegen": {
      "runTsc": true, // invoke `tsc --noEmit` at stage 8
      "trustedProject": true, // reserved for a future wave (engine file writes)
    },
  },
}
```

### Default (hobby) — everything implicit

```jsonc
{
  "name": "hobby-app",
  "schemasDir": "./schemas",
  "configsDir": "./configs",
  "validator": "ajv",
  "schemas": ["./schemas"],
  "emit": {"zod": true, "types": true},
  // No `security` block. Equivalent to the documented defaults above.
}
```

### Hardened CI — explicit lockdown

```jsonc
{
  "name": "hardened-ci-app",
  "schemasDir": "./schemas",
  "configsDir": "./configs",
  "validator": "ajv",
  "schemas": ["./schemas"],
  "emit": {"zod": true, "types": true},
  "security": {
    "http": {
      "timeoutMs": 10000,
      "maxBodyBytes": 1048576,
      "allowPrivateHosts": false,
      "verifyResolvedIps": true,
      "allowedHosts": ["schemas.my-org.dev"],
      "allowRedirects": false,
      "maxRedirects": 1,
    },
    "emitters": {
      "allowProjectManifests": false,
      "allowedKinds": ["zod", "types", "openapi-components"],
    },
    "codegen": {
      "runTsc": true,
      "trustedProject": true,
    },
  },
}
```

### Per-section behaviour

- **`security.http.*`** — gates the engine's HTTP/HTTPS schema fetcher. Every `security.http.*` field is honored at runtime by `HttpSchemaSource`. Precedence (highest first):
  1. `loopback.config.json#/security/http/<field>` — explicit per-project
  2. `LOOPBACK_CONTRACTS_<FIELD>` env var — operator override at the shell
  3. Built-in default

  Env vars: `LOOPBACK_CONTRACTS_HTTP_TIMEOUT_MS`, `LOOPBACK_CONTRACTS_HTTP_MAX_BYTES`, `LOOPBACK_CONTRACTS_ALLOW_PRIVATE_HOSTS`. Use the config block when possible — it's discoverable + reviewable; env vars are the override-from-CI escape hatch.

- **`security.emitters.allowProjectManifests`** — when `false`, `ManifestEmitterBooter` skips the `<projectRoot>/emitters/*.emitter.json` discovery scan (built-in manifests shipped with the plugin still register). Pin to `false` in CI to keep an attacker who can drop a `*.emitter.json` into the tree from registering a code-execution path through the template engine.
- **`security.emitters.allowedKinds`** — when set, every discovered manifest whose `kind` is not in the list is dropped at boot (logged under `DEBUG=loopback:contracts:manifest-emitter-booter`). Unset means "every discovered kind registers".
- **`security.codegen.runTsc`** — when `false`, stage 8 (`tsc --noEmit`) is skipped without needing the CLI `--skip-tsc` flag. Useful when the project already runs `tsc` separately in CI. The CLI `--skip-tsc` flag remains and OR's with this setting.
- **`security.codegen.trustedProject`** — reserved for a future wave that will gate engine file writes on this flag. Declared today so consumer configs can opt in early without a schema bump later.

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
