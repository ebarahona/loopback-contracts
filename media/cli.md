# CLI command reference

`@ebarahona/loopback-contracts` ships fifteen `lb-contracts` subcommands. Four scaffolders (`init`, `contract`, `ds`, `override`) write once and refuse to overwrite. The remaining commands regenerate idempotently.

## Commands

| Command                                               | What it does                                                                                                                                                                                               | If target exists                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `lb-contracts init`                                   | Scaffolds `loopback.config.json` (interactive: dirs, remote sources, validator, default sidecar emissions)                                                                                                 | Errors. Hand-edit the file to change settings.                              |
| `lb-contracts contract <name>`                        | Scaffolds `schemas/<name>.schema.json` + `configs/<name>.config.json` (interactive)                                                                                                                        | Errors. Hand-edit JSON to revise; `lb-contracts override` for TS extension. |
| `lb-contracts ds <name> --adapter <kind>`             | Scaffolds an entry in `datasources.json` (creates the file if missing)                                                                                                                                     | Errors on duplicate entry. Hand-edit `datasources.json` to modify.          |
| `lb-contracts override <kind> <contract>`             | Scaffolds an extension stub (`src/<dir>/<contract>.<kind>.ts`)                                                                                                                                             | Errors (already overridden). Delete and re-run to start fresh.              |
| `lb-contracts gen`                                    | Regenerates `_meta/*.schema.json` + all `.base.*` TS files                                                                                                                                                 | Idempotent. Never touches authored JSON or extension TS.                    |
| `lb-contracts gen --emit-zod`                         | `gen` + emits `*.zod.ts` per schema                                                                                                                                                                        | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-types`                       | `gen` + emits `*.types.ts` (pure TS interface) per schema                                                                                                                                                  | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-graphql`                     | `gen` + emits `*.graphql.ts` (code-first decorators); optional `--emit-graphql-sdl` adds `*.graphql` SDL text                                                                                              | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-cloudevents`                 | `gen` + emits `*.cloudevents.ts` (typed `CloudEvent<T>` wrappers)                                                                                                                                          | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-asyncapi`                    | `gen` + emits `*.asyncapi.yaml` (AsyncAPI 3.0 message-catalog fragments)                                                                                                                                   | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-proto`                       | `gen` + emits `*.proto` (Protocol Buffers schema)                                                                                                                                                          | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-avro`                        | `gen` + emits `*.avsc` (Avro schema)                                                                                                                                                                       | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-openapi-components`          | `gen` + emits `*.openapi-components.yaml` (OAS 3.x components fragment)                                                                                                                                    | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-mock-data`                   | `gen` + emits `*.mock.json` (one valid sample per schema via `json-schema-faker`)                                                                                                                          | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --emit-mongodb`                     | `gen` + emits `*.mongodb.json` (MongoDB `$jsonSchema` collection validator, experimental)                                                                                                                  | Sidecars regenerate with bases.                                             |
| `lb-contracts gen --allow-breaking`                   | `gen` accepting breaking schema changes; updates `contracts.lock.json`                                                                                                                                     | Same as `gen`.                                                              |
| `lb-contracts gen --out-dir <dir>`                    | `gen` writing models + sidecars to `<dir>` (default `src/models`, config key `outputDir`; must be inside the project, outside `node_modules`, `.git`, `_meta`, `.loopback` and the schemas / configs dirs) | Same as `gen`.                                                              |
| `lb-contracts gen --watch` (alias `lb-contracts dev`) | Continuous regen via `chokidar`; respects whichever sidecar flags are set                                                                                                                                  | Re-runs the right pipeline phase per file kind.                             |
| `lb-contracts validate`                               | Read-only Ajv pass over all authored files against `_meta/*.schema.json`; reports errors with `instancePath` pointers                                                                                      | No writes.                                                                  |

## Configuration parity

Every emit flag has a matching `loopback.config.json` setting (`"emit": {"zod": true, "graphql": true, ...}`) so the flag becomes the default for every `lb-contracts gen` invocation without typing it.

## Breaking-change gate

`contracts.lock.json` at the project root holds the last accepted form of every schema loaded from a local source (key-sorted, keyed by `$id`), and a `sha256-` content digest of every schema loaded from a remote source (see [Remote sources](#remote-sources)). Commit it. On every `lb-contracts gen` and `lb-contracts validate`, stage 6 classifies each loaded schema against its baseline entry:

- **unchanged / additive** (annotation edits, a new optional property, a new enum value, a loosened or removed bound, a required property made optional, a widened type, a new schema): passes.
- **breaking** (a property removed or newly required, an enum value removed, a type tightened or changed, a bound added or tightened, a `pattern` / `format` added or changed, `additionalProperties` closed, a schema removed, or any change inside `oneOf` / `anyOf` / `allOf` / `if` / `$ref` / other unmodelled keywords): the command fails with exit code 1, names the schema, and writes nothing.

To accept a breaking change, re-run `lb-contracts gen --allow-breaking` (or declare `migration-strategy.<schemaId>.mode = 'allow'` in `loopback.config.json` for a standing exception) and commit the updated `contracts.lock.json`. The baseline is written only by a successful `gen`: after codegen succeeds, unchanged and additive edits are recorded automatically, and breaking edits only when allowed. `validate` (with or without `--allow-breaking`) never writes it, so CI can run `lb-contracts validate` against the committed baseline. A missing file means every schema is new (the first `gen` creates it); a corrupt or unreadable one fails the run instead of silently disabling the gate. The comparison is syntactic, so a semantically equivalent rewrite (e.g. `oneOf` to `if`/`then`) can be reported as breaking; accept it with `--allow-breaking`. "Existing payloads" are those carrying only the properties the previous schema declares, so a new optional property is additive even on an open object. Renaming a schema's `$id` is a removal plus an addition, so it needs `--allow-breaking` once.

### Configuration

```json
{"baseline": {"enabled": true, "includeRemote": false}}
```

- `enabled` (default `true`): `false` turns stage 6 off entirely; `contracts.lock.json` is neither read nor written.
- `includeRemote` (default `false`): store full bodies of remote-source schemas too; see below.

Unknown keys under `baseline` fail stage 5.

### Remote sources

Schemas fetched from `npm:`, `git+...`, `https://` or a plugin-registered scheme are pinned by their source descriptor (package version, git ref). By default the lock records them only by `$id` and a `sha256-` digest of their canonical JSON, so a private contract's content (including its `examples` and `default` values) never lands in your repository. A digest carries no structure to classify, so **any** change to such a schema (typically after bumping its version pin) counts as breaking: re-run `lb-contracts gen --allow-breaking` once to accept it. Set `"baseline": {"includeRemote": true}` to store their bodies and have remote edits classified like local ones; only do so when the remote contracts may be committed to this repository.

### Single writer

`contracts.lock.json` is written only by `lb-contracts gen`, atomically (temp file, `fsync`, rename). Run one `gen` at a time per project: if the file changed on disk between stage 6 reading it and the write (a `--watch` session plus a manual `gen`, say), the run fails with `contracts.lock.json changed on disk during this run` instead of overwriting the other run's result. Re-run `gen`.

### Upgrading from 0.1.0

0.1.0 diffed schemas only when a source version pin changed, using `.loopback/cache/diff-state.json`. From 0.2.0 the gate runs on every `gen` and `validate` against the committed lock:

1. Run `lb-contracts gen` once. With no `contracts.lock.json` present, every schema is new, so the run passes and creates the file.
2. Commit `contracts.lock.json`. CI (`lb-contracts validate`) now gates against it.
3. Delete `.loopback/cache/diff-state.json` if present; nothing reads it any more.
4. Removing a schema or renaming its `$id` now fails until `lb-contracts gen --allow-breaking` is run once.

The full list of 0.2.0 behaviour changes is in [upgrade-0.2.md](./upgrade-0.2.md).

## Strict mode

`--strict` promotes every lossy-translation warning at codegen to an error, halting the run before any files land. Useful in CI where any silent approximation is a build failure.

## Skip type-check

`--skip-tsc` bypasses the final `tsc --noEmit` validation stage. Useful for faster local rerolls when the project already runs `tsc` separately. The `security.codegen.runTsc` setting in `loopback.config.json` has the same effect persistently; see [docs/security.md](./security.md).

## Importing from other formats

`loopback-contracts` consumes JSON Schema only. Bringing schemas in from Zod, OpenAPI, WSDL, Avro, proto, GraphQL SDL, AsyncAPI, or a live database is the job of [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import) (`lb4 import-zod`, `lb4 import-openapi`, `lb4 import-wsdl`, etc.). Its commands land schemas in `schemas/*.schema.json` where `loopback-contracts` then consumes them.
