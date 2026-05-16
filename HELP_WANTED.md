# Help Wanted

This project ships the engine, 15 CLI commands, and 9 sidecar emitters
at v1.0. Several extension surfaces are deliberately left open for the
community: additional emitters, additional schema-source resolvers,
larger fixture corpora, and manifest-emitter templates for org-internal
envelope formats. Contributions on any of these grow the value of the
plugin without requiring engine changes — the architecture explicitly
makes that possible.

## New emitter for a not-yet-covered format

Directory: `src/emitters/`

A new emitter is a class implementing `ProjectionEmitter` registered
under `ContractsBindings.EMITTER_TAG`. The engine auto-integrates it:
the CLI flag parser accepts `--emit-<your-kind>`, `lb4 init` shows it
in the sidecar prompt, and the generated
`_meta/emitter-config.schema.json` enumerates it. No engine code
changes.

Concrete formats wanted at v1.0:

### gRPC web client stubs

Today the `--emit-proto` flag emits `.proto` files; consumers run
`protoc` themselves. A `--emit-grpc-web` emitter that produces typed
TS clients (e.g., via `ts-proto` or `@grpc/proto-loader` + generated
clients) closes the loop for browser apps. Output: `*.grpc-web.ts` per
service-shaped schema.

### OpenAPI 3.1 paths fragment

Today `--emit-openapi-components` emits the `components.schemas` block.
A `--emit-openapi-paths` emitter that derives the `paths` block from
the generated CRUD controllers (mounting the seven CRUD methods per
contract) produces a complete OpenAPI 3.1 document without the LB4 runtime.
Output: `*.openapi-paths.yaml` per contract.

### tRPC router from JSON Schema 2020-12

A `--emit-trpc` emitter that walks the schema graph and produces a
tRPC router with input/output validators wired to the existing
`*.zod.ts` sidecar. Output: `*.trpc.ts` per contract.

## New SOURCE_TAG resolver

Directory: `src/sources/`

The engine ships four built-in source kinds (`local`, `npm:`,
`git+https`, `https`). Plugins can contribute additional kinds under
`ContractsBindings.SOURCE_EXTENSION_TAG`. Each resolver implements a
single interface: given a source spec, return a stream of parsed JSON
Schema documents.

Concrete resolvers wanted at v1.0:

### `s3://` resolver

Pull schemas from a versioned S3 bucket (e.g.,
`s3://my-org-contracts/v1.2.0/`). Useful for orgs that publish
contracts to S3 from a centralized authoring repo and want every
downstream consumer to pin a version without forking. Should support
the standard AWS credential chain.

### `oci://` resolver

Pull schemas from an OCI artifact registry (e.g.,
`oci://ghcr.io/my-org/contracts:v1.2.0`). Aligns contract distribution
with the same registries already storing container images and Helm
charts. Should support `oras` semantics for arbitrary artifact pulls.

## Fixture schemas for the integration test corpus

Directory: `src/__tests__/fixtures/`

The integration test suite runs the engine end-to-end against a set of
realistic schemas. The current corpus is small and skewed toward
simple shapes. Contributions that broaden coverage:

- **Cyclic relations**: `Customer` `hasMany` `Order`, `Order`
  `belongsTo` `Customer`, plus a self-reference (`Comment` with a
  `parent` of the same type). Exercises `$ref` resolution and
  emitter cycle handling.
- **`oneOf` discriminated unions**: a `Notification` schema with
  `email`, `sms`, `push` variants discriminated on a `kind` property.
  Exercises every emitter's union handling (Zod
  `discriminatedUnion`, GraphQL `union` + `__resolveType`, proto
  `oneof`, Avro union).
- **JSON Schema 2020-12 dynamic anchors** (`$dynamicRef` /
  `$dynamicAnchor`): a base schema with extension points and a
  derived schema substituting concrete types. Documents which
  emitters can and cannot represent the feature, with explicit
  lossy-translation reports.
- **`format` corner cases**: `format: uri`, `format: uri-template`,
  `format: regex`, `format: idn-email`, `format: ipv6`, etc. Pins
  the documented format-to-emitter mapping table.

## Manifest emitter templates for org-internal envelope formats

Directory: `src/__tests__/fixtures/manifest-emitters/`

The manifest+template contribution path lets project authors ship a
new emitter as one JSON manifest plus one EJS template — no TS, no
npm publish. Reference templates that cover common org-internal needs:

- **Audit-log envelope**: wrap every event with `{actor, occurred_at,
trace_id, payload}` fields and emit a typed wrapper per schema.
- **Org-internal event envelope** (CloudEvents-shaped but with
  org-specific extension attributes): emit a typed wrapper per
  schema parameterized on the org's standard attribute set.
- **REST response envelope** (`{data, meta, errors}` shape): emit a
  per-contract response-wrapper type so handlers and clients agree on
  the envelope without each writing their own.

Each reference template lives under
`src/__tests__/fixtures/manifest-emitters/`, with a golden-file
integration test asserting the rendered output for a known input
schema.

## How to contribute

1. Pick one item from the lists above.
2. Open an issue describing your approach so we can align scope.
3. Submit a PR following [CONTRIBUTING.md](./CONTRIBUTING.md).
4. Every new emitter or source resolver requires an integration test
   under `src/__tests__/integration/` that exercises the extension
   point end-to-end against a fixture schema, with the output asserted
   against a committed golden file.
