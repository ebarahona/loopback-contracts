# Roadmap

## v1.0 (current)

- Engine: 8-stage validation pipeline, `ProjectionEmitter` interface,
  6 extension-point tags, EJS template runtime, file writer with
  regen-always / scaffold-once semantics, error reporter with lossy-
  translation surfacing, `--strict` mode.
- CLI: 15 commands (`lb4 init`, `lb4 contract`, `lb4 ds`,
  `lb4 override`, `lb4 gen`, eight `lb4 gen --emit-<kind>` variants,
  `lb4 gen --watch` / `lb4 dev`, `lb4 validate`).
- Core LB4 emitters: `@model` / `@repository` / `@controller` /
  `@lifeCycleObserver` datasource.
- Sidecar emitters (9 total, all opt-in via `--emit-<kind>`): Zod,
  pure TS interfaces, GraphQL (code-first decorators with optional
  SDL projection), CloudEvents, AsyncAPI 3.0, Protocol Buffers, Avro,
  OpenAPI components fragment, mock fixture data.
- Schema sources: `local`, `npm:`, `git+https`, `https` resolvers
  built in.

Note: `--emit-graphql` ships at v1.0 with the code-first decorator
output as the primary form, and the SDL text projection as the
secondary form (gated by `--emit-graphql-sdl`).

## v1.1 (planned, non-breaking)

- `x-emit-skip` per-schema gating — opt individual schemas out of
  specific emitters via an extension keyword in the source schema.
- Additional `SOURCE_TAG` providers: `s3://` (versioned S3 buckets)
  and `oci://` (OCI artifact registries). Implemented under the
  `SOURCE_EXTENSION_TAG` extension point; no engine changes required.
- `migration-strategy` config shape — formalizes how a project
  declares its policy for handling breaking schema changes (default,
  per-contract overrides, fail-fast vs warn).
- `lb4 emitters list` CLI command — enumerates every registered
  emitter (built-in, plugin, manifest), its tier, its peer-deps, and
  whether it is currently enabled in `loopback.config.json`.
- `lb4 contracts diff` CLI command — cross-version diff report
  against a base ref, classifying every change by severity
  (additive, modifying, breaking) and grouping by contract.

## v2.0 (reserved)

Reserved for any breaking changes to the `ProjectionEmitter`
interface. The interface is the published API every external emitter
depends on; bumping it is a major-version event and will not happen
inside v1.x. No concrete v2.0 work is scheduled at this time.
