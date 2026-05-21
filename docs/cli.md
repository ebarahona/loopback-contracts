# CLI command reference

`@ebarahona/loopback-contracts` ships fifteen `lb-contracts` subcommands. Four scaffolders (`init`, `contract`, `ds`, `override`) write once and refuse to overwrite. The remaining commands regenerate idempotently.

## Commands

| Command                                               | What it does                                                                                                          | If target exists                                                            |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `lb-contracts init`                                   | Scaffolds `loopback.config.json` (interactive: dirs, remote sources, validator, default sidecar emissions)            | Errors. Hand-edit the file to change settings.                              |
| `lb-contracts contract <name>`                        | Scaffolds `schemas/<name>.schema.json` + `configs/<name>.config.json` (interactive)                                   | Errors. Hand-edit JSON to revise; `lb-contracts override` for TS extension. |
| `lb-contracts ds <name> --adapter <kind>`             | Scaffolds an entry in `datasources.json` (creates the file if missing)                                                | Errors on duplicate entry. Hand-edit `datasources.json` to modify.          |
| `lb-contracts override <kind> <contract>`             | Scaffolds an extension stub (`src/<dir>/<contract>.<kind>.ts`)                                                        | Errors (already overridden). Delete and re-run to start fresh.              |
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

## Configuration parity

Every emit flag has a matching `loopback.config.json` setting (`"emit": {"zod": true, "graphql": true, ...}`) so the flag becomes the default for every `lb-contracts gen` invocation without typing it.

## Strict mode

`--strict` promotes every lossy-translation warning at codegen to an error, halting the run before any files land. Useful in CI where any silent approximation is a build failure.

## Skip type-check

`--skip-tsc` bypasses the final `tsc --noEmit` validation stage. Useful for faster local rerolls when the project already runs `tsc` separately. The `security.codegen.runTsc` setting in `loopback.config.json` has the same effect persistently; see [docs/security.md](./security.md).

## Importing from other formats

`loopback-contracts` consumes JSON Schema only. Bringing schemas in from Zod, OpenAPI, WSDL, Avro, proto, GraphQL SDL, AsyncAPI, or a live database is the job of [`@ebarahona/loopback-contracts-import`](https://github.com/ebarahona/loopback-contracts-import) (`lb4 import-zod`, `lb4 import-openapi`, `lb4 import-wsdl`, etc.). Its commands land schemas in `schemas/*.schema.json` where `loopback-contracts` then consumes them.
