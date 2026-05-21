# Architecture

The engine is a deterministic pipeline from JSON Schema 2020-12 inputs to LoopBack 4 + OpenAPI 3.1 + opt-in sidecar outputs. This document covers the pipeline stages, the schema-source resolvers, the extension-point catalog, and the on-disk project layout.

## 8-stage validation pipeline

Every `lb-contracts gen` invocation walks the same eight stages in order. Failure at any stage halts the run with an actionable error pointing at the offending file and JSON pointer. Stage labels match the `stage` field surfaced on thrown `ContractsPipelineError`s (e.g. `source-fetch`, `schema-validation`, `backward-compat-diff`) so a CI failure is greppable straight back to this list.

1. **Source fetch.** Resolve every source spec in `loopback.config.json` via its `SOURCE_TAG` resolver; download remote schemas into `.loopback/cache/` (with content-addressed caching); union the result into the registry.
2. **Schema validation.** Ajv-validates every fetched schema against the JSON Schema 2020-12 meta-schema; requires a non-empty top-level `$id`. Catches malformed schemas and `$id`-less documents before any other stage sees them.
3. **Dedupe.** Add every schema to the in-memory registry, keyed by `$id`. Same content silently dedupes (a schema can legitimately surface through multiple sources); a duplicate `$id` with differing content halts the run.
4. **`$ref` resolution.** Walk every schema and verify that every `$ref` resolves inside the merged registry per RFC 3986 §5.3 (base-URI tracking through nested `$id`). Remote `$ref`s (`git+`, `npm:`) are out of scope for v1.0 and fail loud.
5. **Config validation.** Re-derive `_meta/model-config.schema.json`, `_meta/datasources.schema.json`, `_meta/emitter.schema.json`, and `_meta/loopback-config.schema.json` from the project's installed connectors and registered emitters. Then Ajv-validate every `configs/*.config.json`, `datasources.json`, and `loopback.config.json` against the regenerated meta-schemas. Cross-reference typos and unknown emit slots fail loud here, not at codegen time.
6. **Backward-compat diff.** For every schema whose source descriptor changed pin (e.g. `#v1.2.0` -> `#v1.3.0`), classify the shape delta as `additive` / `narrowing` / `breaking`. A `breaking` verdict refuses the run unless `--allow-breaking` is set or `migration-strategy.<schemaId>.mode = 'allow'` is declared in `loopback.config.json`.
7. **Codegen (emitter dispatch + file write).** For every schema, for every enabled emitter (built-in, plugin, manifest), call `emit(EmitterContext)`; collect `EmittedFile[]`; apply the regen-always / scaffold-once rules in a single atomic commit (`.base.*` files force-overwrite, extension files skip-if-exists, barrels regenerate, `_meta/` regenerates). Lossy-translation warnings are aggregated and printed.
8. **`tsc --noEmit`.** Invokes `tsc --noEmit` against the project's `tsconfig.json` to verify the generated TS compiles. Runs by default; opt out with `--skip-tsc` or `security.codegen.runTsc = false`. No-ops cleanly when the project has no `tsconfig.json`.

## Schema sources

Four built-in source kinds, plus the `SOURCE_TAG` extension point for plugins to contribute additional resolver schemes.

| Source                                 | Spec format                                          | Notes                                                                      |
| -------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `local`                                | `./schemas/`                                         | Default. Schemas live in the project repo.                                 |
| `npm:`                                 | `npm:@my-org/contracts@^1.2.0`                       | Installs the package and reads schemas from its `dist/schemas/` directory. |
| `git+https`                            | `git+https://github.com/my-org/contracts.git#v1.2.0` | Shallow-clones into `.loopback/cache/`, reads from the ref's checkout.     |
| `https`                                | `https://my-org.dev/contracts/order.schema.json`     | Per-file HTTP fetch; cached under `.loopback/cache/`.                      |
| `<extension>` (e.g. `s3://`, `oci://`) | Defined by the plugin under `SOURCE_TAG`             | See [HELP_WANTED.md](../HELP_WANTED.md) for the open list.                 |

Source specs are configured in `loopback.config.json` under the `schemas` array. The engine resolves every spec in declaration order and merges the resulting schema set before validation.

HTTPS fetches are subject to the security guards in [docs/security.md](./security.md) (SSRF blocks, DNS-rebinding protection, host allowlist, response-size cap, redirect cap).

## Extension points

Six extension-point tags. All stable at v1.0. Plugins register bindings under the appropriate tag and the engine resolves them via LB4's native `@extensions.list({tag: ...})` mechanism, the same pattern `@loopback/authentication` uses for strategies and `@loopback/boot` uses for booters.

| Tag                           | What it extends                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EMITTER_TAG`                 | Add a new `ProjectionEmitter` for a not-yet-covered output format. CLI auto-accepts `--emit-<kind>`; `lb-contracts init` auto-shows the option.                             |
| `SOURCE_TAG`                  | Schema source resolvers, built-in (`local`, `npm:`, `git+https`, `https`) AND plugin-contributed schemes (`s3://`, `oci://`, etc.).                                         |
| `SOURCE_EXTENSION_TAG`        | Contribute import-source wizard entries to `lb-contracts contract` (e.g. Zod import, OpenAPI import). Not for adding source resolution schemes (use `SOURCE_TAG` for that). |
| `EXTENSION_KEYWORD_TAG`       | Register a handler for an `x-*` keyword in source schemas (e.g. `x-graphql`, `x-emit-skip`). The engine routes the keyword to your handler.                                 |
| `META_SCHEMA_CONTRIBUTOR_TAG` | Contribute additional enums to the generated `_meta/*.schema.json` files (e.g. plugin-specific adapter kinds, valid emitter options).                                       |
| `VALIDATOR_TAG`               | Register additional Ajv formats (`phone`, `objectid`, org-internal formats) and keywords used by source schemas.                                                            |

When an emitter binding appears under `EMITTER_TAG`, the CLI flag parser, `lb-contracts init` prompts, and meta-schema generator all pick it up automatically. Emitter authors never edit the CLI, the prompt machinery, or the meta-schema generator.

Full reference (interface contracts, lifecycle, versioning policy, comprehensive examples for both contribution paths): [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md).

## Project layout

The `.base.` suffix is the only discriminator between regen targets and user-editable extensions.

```
my-app/
├── loopback.config.json              # AUTHORED (lb-contracts init, then hand-edit)
├── datasources.json                  # AUTHORED (lb-contracts ds + hand-edit)
├── schemas/                          # AUTHORED (lb-contracts contract + hand-edit)
│   └── order.schema.json
├── configs/                          # AUTHORED (lb-contracts contract + hand-edit)
│   └── order.config.json
├── _meta/                            # GENERATED, gitignore'd
│   ├── model-config.schema.json
│   ├── datasources.schema.json
│   ├── emitter.schema.json
│   └── loopback-config.schema.json
├── .loopback/cache/                  # GENERATED, gitignore'd (remote source cache)
├── emitters/                         # AUTHORED (manifest+template emitters, optional)
│   └── audit-envelope.emitter.json
└── src/
    ├── models/
    │   ├── order.base.model.ts               # REGEN, every lb-contracts gen
    │   ├── order.model.ts                    # ONCE , only on lb-contracts override
    │   ├── order.zod.ts                      # REGEN. --emit-zod
    │   ├── order.types.ts                    # REGEN. --emit-types
    │   ├── order.graphql.ts                  # REGEN. --emit-graphql
    │   ├── order.cloudevents.ts              # REGEN. --emit-cloudevents
    │   ├── order.asyncapi.yaml               # REGEN. --emit-asyncapi
    │   ├── order.proto                       # REGEN. --emit-proto
    │   ├── order.avsc                        # REGEN. --emit-avro
    │   ├── order.openapi-components.yaml     # REGEN. --emit-openapi-components
    │   ├── order.mock.json                   # REGEN. --emit-mock-data
    │   └── index.ts                          # REGEN, barrel
    ├── repositories/
    │   ├── order.base.repository.ts          # REGEN
    │   ├── order.repository.ts               # ONCE , only on lb-contracts override
    │   └── index.ts
    ├── controllers/
    │   ├── order.base.controller.ts          # REGEN
    │   ├── order.controller.ts               # ONCE , only on lb-contracts override
    │   └── index.ts
    └── datasources/
        ├── primary.base.datasource.ts        # REGEN
        ├── primary.datasource.ts             # ONCE , only on lb-contracts override
        └── index.ts
```

File contracts:

- **Authored files** (`schemas/`, `configs/`, `datasources.json`, `loopback.config.json`, `emitters/`) are scaffold-once, refuse-to-overwrite. The CLI errors on duplicates; day-2 edits are hand-edits.
- **`.base.*` files** are regen-always. The engine overwrites them on every `lb-contracts gen`. Never hand-edit.
- **Extension files** (no `.base.` suffix) are scaffold-once via `lb-contracts override`, then owned by the user. The engine refuses to overwrite them after the first emit.
- **`_meta/`** is always generated, never committed. In `.gitignore`.
- **`.loopback/cache/`** is always generated, never committed. In `.gitignore`.

## Stability and semver

Every exported symbol carries exactly one stability tag: `@public`, `@experimental`, or `@internal`. The rules and rationale are documented in [STYLE_GUIDE.md § Stability tags](../STYLE_GUIDE.md).

- The `ProjectionEmitter` interface, the `ContractsBindings.*` namespace, and every other symbol marked `@public` are semver-locked at v1.0. Breaking changes require a major bump and a CHANGELOG entry. The `ProjectionEmitter` interface specifically is reserved for v2.0; no v1.x release will break it.
- `@experimental` symbols ship documented but the signature may break in a minor. New exports default to `@experimental` until at least one real consumer has exercised the surface, then promote to `@public` in a separate PR.
- `@internal` symbols are not part of the package's API. They are excluded from generated TypeDoc; consumers reaching for them accept breakage at any time.
- API Extractor is the source of truth for what is in the public surface; the report drives CI. Surface drift without an accompanying version bump fails CI.
