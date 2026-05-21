# Emitters

Nine sidecar formats ship at v1.0, all opt-in, all off by default. Each is gated by a `--emit-<kind>` flag on `lb-contracts gen` and a matching `loopback.config.json` setting for persistent enablement.

## Output formats

| Flag                        | Output suffix                                            | Tier             | Notes                                                                       |
| --------------------------- | -------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `--emit-zod`                | `*.zod.ts`                                               | Real translation | Discriminator detection, `oneOf` -> `z.discriminatedUnion`, format mapping. |
| `--emit-types`              | `*.types.ts`                                             | Convenience      | Pure TS interface, equivalent to `json-schema-to-typescript`, turnkey.      |
| `--emit-graphql`            | `*.graphql.ts` (+ `*.graphql` with `--emit-graphql-sdl`) | Real translation | Code-first decorators primary, SDL secondary. ID/scalar/nullability rules.  |
| `--emit-cloudevents`        | `*.cloudevents.ts`                                       | Real translation | Typed `CloudEvent<T>` wrappers via the `cloudevents` SDK.                   |
| `--emit-asyncapi`           | `*.asyncapi.yaml`                                        | Real translation | AsyncAPI 3.0 `components.messages` / `components.schemas` fragments.        |
| `--emit-proto`              | `*.proto`                                                | Real translation | Protocol Buffers; scalar mapping, `repeated`, `oneof`, `optional`.          |
| `--emit-avro`               | `*.avsc`                                                 | Real translation | Avro records/enums/unions/maps, logical types (date, decimal, uuid).        |
| `--emit-openapi-components` | `*.openapi-components.yaml`                              | Mechanical       | OAS 3.x `components.schemas` mounted verbatim.                              |
| `--emit-mock-data`          | `*.mock.json`                                            | Convenience      | One valid sample per schema via `json-schema-faker`.                        |

## Configuration

Set per-emitter defaults in `loopback.config.json` so the project's emission set is configured once:

```jsonc
{
  "emit": {
    "zod": true,
    "types": true,
    "openapi-components": true,
  },
}
```

## Lossy-translation reports

JSON Schema is the most expressive contract format the plugin consumes; not every keyword has a clean projection in every output format. The codegen stage aggregates per-emitter lossy-translation warnings and prints them at the end of `lb-contracts gen`. Use `--strict` to promote them to errors (recommended in CI).

Full translation tables (which JSON Schema keywords map cleanly, which are dropped, which trigger warnings) live in [`loopback-contracts.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/loopback-contracts.md).

## Two emitter contribution paths

| Path                    | When to use                                                                                         | What the author ships                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Code-based plugin**   | Real translation work. Zod-like, GraphQL-like, anything needing libraries or programmatic traversal | npm package with `@injectable({tags: {EMITTER_TAG, kind}})` class implementing `ProjectionEmitter`. |
| **Manifest + template** | Mechanical projections, project-local event wrappers, internal envelopes, custom format mirrors     | `emitters/<name>.emitter.json` + EJS template under the project root. No TS code, no npm publish.   |

Both paths register through the same `EMITTER_TAG` binding (see [docs/architecture.md § Extension points](./architecture.md#extension-points)) and follow the same `ProjectionEmitter` lifecycle. The manifest path is the lower-friction option: a project author with no TS publishing infrastructure can ship a new envelope-format emitter as two files committed to their own repo. The engine's `ManifestEmitterBooter` discovers them at boot, subject to the `security.emitters.allowProjectManifests` and `security.emitters.allowedKinds` guards.

Full interface reference, lifecycle, and extension examples: [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md).
