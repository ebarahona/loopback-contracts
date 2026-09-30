# Emitters

Ten sidecar formats ship, all opt-in, all off by default. Each is gated by a `--emit-<kind>` flag on `lb-contracts gen` and a matching `loopback.config.json` setting for persistent enablement.

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
| `--emit-mongodb`            | `*.mongodb.json`                                         | Real translation | Experimental. MongoDB `$jsonSchema` collection validator; see below.        |

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

## `$ref`, `$defs` and `oneOf`

The zod, types and openapi-components emitters translate references the same way:

- A `$ref` to another loaded schema (`"money"`, `"customer.v1"`, a URL `$id`) points at that schema's own output: an import of `MoneySchema` / `Money`, or `#/components/schemas/Money` in the OpenAPI fragment.
- A `$ref` with a JSON Pointer fragment (`"#/$defs/status"`, `"money#/$defs/amount"`) is inlined from the target document. The OpenAPI fragment therefore carries no `$defs` block and no `#/$defs/...` pointer (which would resolve against the OpenAPI document rather than the component). A fragment that recurses into itself is reported as `recursive-fragment-$ref`.

Zod `oneOf`:

- "Exactly one of these keys" (`"oneOf": [{"required": ["insuredAge"]}, {"required": ["dateOfBirth"]}]` next to `properties`) emits the object schema plus a `.superRefine` that requires exactly one branch to hold. Both properties stay optional in the inferred type.
- A `oneOf` with `discriminator.propertyName` whose branches are object schemas that each require that property as a `type: "string"` `const` emits `z.discriminatedUnion`. Other `oneOf`s whose branches are full schemas emit an exactly-one refinement over the branches.
- A `oneOf` with a bare branch the Zod renderer cannot express (e.g. `{"minProperties": 2}`, or `{"required": [...]}` mixed with other shapes) is dropped from the Zod output and reported as `unsupported-oneOf`, an error under `--strict`.

The types emitter keeps `minItems` / `maxItems` arrays as `T[]` (no tuple types); the bounds stay in the JSDoc and are enforced by the validators. This changed in 0.2.0: 0.1.0 typed an array with `minItems` equal to `maxItems` as a fixed tuple (`[string, string]`), so consumer code that destructures or indexes it as a tuple no longer type-checks. When the upstream compiler names the root type differently from the canonical name (a `title` of `Customer` on `customer.v1`), the file also exports `export type CustomerV1 = Customer;`: the canonical name is what other schemas' `.types.ts` files import.

## Naming and collisions

A plain `$id` (`money`, `customer.v1`) names its outputs exactly as in 0.1.0. A URL or URN `$id` is sanitised: the type name comes from `title` (else the last non-version path segment), the file slug from every path segment (`https://schemas.example.com/intake/1.0.0` → `intake-1-0-0`, type `Intake` or the title).

Names are then made unique across the run, deterministically and independent of load order. A plain id never changes; every URL / URN id whose name would clash with a plain id or with another URL id is qualified:

- a clashing file slug gains the host: `https://a.example.com/x/address` and `https://b.example.com/x/address` write `a-example-com-x-address.*` and `b-example-com-x-address.*`;
- a clashing type name becomes the words of the file slug: two versions `…/intake/1.0.0` and `…/intake/2.0.0` both titled `Intake` name `Intake100` and `Intake200` (and key OpenAPI components by those names, so merged fragments never overwrite each other);
- anything still clashing gains the first 8 hex digits of the SHA-256 of the full `$id`.

Adding a schema can therefore rename an existing URL-id schema's outputs when the two clash; the `$ref`s, imports and component refs of every emitter follow. Two plain ids that map to the same file (`user.v1` and `user-v1`) fail the run with an error naming both `$id`s.

## MongoDB `$jsonSchema` validator (experimental)

`--emit-mongodb` (or `"emit": {"mongodb": true}`) writes `models/<slug>.mongodb.json` per schema, shaped `{"$jsonSchema": {...}}`, ready for `db.createCollection(name, {validator})` or `db.runCommand({collMod: name, validator})`. The surface is `@experimental`.

MongoDB implements a draft-4 subset of JSON Schema with a `bsonType` extension and [rejects unknown keywords](https://www.mongodb.com/docs/manual/reference/operator/query/jsonSchema/), so the emitter translates rather than copies:

| JSON Schema 2020-12                                                                                                                                                                                                                                                                   | MongoDB output                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `type`                                                                                                                                                                                                                                                                                | `bsonType`: `string`, `bool`, `object`, `array`, `null`; `integer` -> `["int", "long"]`; `number` -> `number` (any numeric) |
| `$ref` (local `#/$defs/...` and cross-schema), `$defs`                                                                                                                                                                                                                                | Inlined; `$defs` dropped. `$ref` siblings kept via `allOf`. A recursive `$ref` becomes `{}` (lossy error).                  |
| `required`, `enum`, `minimum`, `maximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `items`, `minItems`, `maxItems`, `uniqueItems`, `min/maxProperties`, `properties`, `patternProperties`, `additionalProperties`, `allOf`, `anyOf`, `oneOf`, `not`, `title`, `description` | Kept (subschemas translated recursively). An empty `required` is dropped (draft 4 forbids it).                              |
| `exclusiveMinimum: n` / `exclusiveMaximum: n`                                                                                                                                                                                                                                         | `minimum: n, exclusiveMinimum: true` (draft-4 boolean form)                                                                 |
| `const`                                                                                                                                                                                                                                                                               | `enum: [value]`; with a sibling `enum`, the intersection (an empty one keeps both, so nothing validates)                    |
| `prefixItems` + `items`                                                                                                                                                                                                                                                               | `items: [...]` + `additionalItems`                                                                                          |
| `dependentRequired`, `dependentSchemas`                                                                                                                                                                                                                                               | `dependencies`                                                                                                              |
| `$schema`, `$id`, `$comment`, `default`, `examples`, `deprecated`, `readOnly`, `writeOnly`, `x-*`                                                                                                                                                                                     | Dropped silently (no validation effect).                                                                                    |
| `format`, `if`/`then`/`else`, `contains`, `propertyNames`, `unevaluated*`, `$dynamicRef`, ...                                                                                                                                                                                         | Dropped with a lossy warning; `--strict` makes it an error.                                                                 |

Per-schema options, in an `x-mongodb` block on the source schema:

| Option       | Values                                           | Default       | Effect                                                                                                                                                |
| ------------ | ------------------------------------------------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integer`    | `int`, `long`, `int-or-long`, `number`           | `int-or-long` | BSON type(s) for `integer`. Use `number` when writers may store large integers as `double` (the Node.js driver does for values beyond 32 bits).       |
| `number`     | `double`, `decimal`, `number`                    | `number`      | BSON type for `number`.                                                                                                                               |
| `dateTime`   | `string`, `date`                                 | `string`      | `date` validates `{"type": "string", "format": "date-time"}` as a BSON `date` (for collections that store native dates). Otherwise it stays a string. |
| `idBsonType` | a `bsonType` alias or array of aliases, or `any` | `objectId`    | Type of the injected `_id` (below).                                                                                                                   |

`_id` and `additionalProperties: false`: MongoDB adds `_id` to every document, so a root schema that sets `additionalProperties: false` would reject every insert. When the root is closed and does not declare `_id`, the emitter adds `"_id": {"bsonType": "objectId"}` (or `idBsonType`) as the first root property. A declared `_id` is translated as authored. Note that the LoopBack MongoDB connector stores the model's id property as `_id`; if the contract's id property is `id`, declare `_id` in the schema or leave the root open.

## Lossy-translation reports

JSON Schema is the most expressive contract format the plugin consumes; not every keyword has a clean projection in every output format. The codegen stage aggregates per-emitter lossy-translation warnings and prints them at the end of `lb-contracts gen`. Use `--strict` to promote them to errors (recommended in CI). A report with `severity: 'error'` (for example `unresolved-$ref` or `recursive-$ref` from the MongoDB emitter) is printed like a warning and only fails the run under `--strict`.

Full translation tables (which JSON Schema keywords map cleanly, which are dropped, which trigger warnings) live in [`loopback-contracts.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/loopback-contracts.md).

## Two emitter contribution paths

| Path                    | When to use                                                                                         | What the author ships                                                                               |
| ----------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Code-based plugin**   | Real translation work. Zod-like, GraphQL-like, anything needing libraries or programmatic traversal | npm package with `@injectable({tags: {EMITTER_TAG, kind}})` class implementing `ProjectionEmitter`. |
| **Manifest + template** | Mechanical projections, project-local event wrappers, internal envelopes, custom format mirrors     | `emitters/<name>.emitter.json` + EJS template under the project root. No TS code, no npm publish.   |

Both paths register through the same `EMITTER_TAG` binding (see [docs/architecture.md § Extension points](./architecture.md#extension-points)) and follow the same `ProjectionEmitter` lifecycle. The manifest path is the lower-friction option: a project author with no TS publishing infrastructure can ship a new envelope-format emitter as two files committed to their own repo. The engine's `ManifestEmitterBooter` discovers them at boot, subject to the `security.emitters.allowProjectManifests` and `security.emitters.allowedKinds` guards.

Full interface reference, lifecycle, and extension examples: [`contracts-extensibility.md`](https://github.com/ebarahona/loopback-plugins/blob/main/docs/contracts-extensibility.md).
