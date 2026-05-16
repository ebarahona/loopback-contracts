---
name: new-source-resolver
description: Scaffold a new SchemaSource implementation under SOURCE_TAG (e.g. s3://, oci://, file+brotli://). Generates the resolver class, registration glue, optional auth-extension hook, caching plumbing, and integration test stub.
---

# new-source-resolver

Scaffold a new `SchemaSource` resolver end-to-end for `@ebarahona/loopback-contracts`. Source resolvers fetch raw schema bytes from a URI scheme (`file://`, `https://`, `s3://`, `oci://`, `git+ssh://`, `file+brotli://`, etc.) and hand them to the engine for validation, caching, and codegen. The engine discovers resolvers via `@extensions.list({tag: SOURCE_TAG})`.

**Reference (read before scaffolding):**

- `/Users/ed/dev/oss/loopback-plugins/docs/loopback-contracts.md` — `## Pipeline`, `### Remote-source failure-mode matrix` (line ~952), `### CI safety for version-pin bumps`, init flow around `Add a remote schema source now?` (line ~742).
- `/Users/ed/dev/oss/loopback-plugins/docs/contracts-extensibility.md` — same `@extensions.list/view` pattern used for emitters applies to source resolvers.

## When to use

- Adding a new URI scheme the engine should fetch schemas from.
- Wrapping an existing resolver with new auth (e.g. S3 + SigV4, OCI + bearer token, Git + SSH).
- Adding a compression/transport variant (`file+brotli://`, `https+gzip://`).

Do NOT use this skill for changes to the validation pipeline, the cache layer's eviction policy, or the integrity-pin format — those are engine internals.

## Inputs the skill must collect from the user first

Ask explicitly:

1. **`scheme`** — URI scheme without `://` (e.g. `s3`, `oci`, `file+brotli`). Drives resolver registration and CLI URI parsing.
2. **`description`** — one-liner shown in `lb4 init` prompts and resolver-list output.
3. **`auth`** — none / static token / per-request signer (e.g. SigV4). If auth is needed, decide whether to expose an `AuthExtension` hook for users to plug their own credential provider.
4. **`integrityModel`** — does this scheme support content-addressable hashes (digest in URI) or version pins only? Drives the engine's lockfile entry shape.
5. **`cacheKey`** — what makes a fetch result reusable? URI + version pin, URI + digest, or URI + ETag.
6. **`peerDeps`** — npm packages required (e.g. `@aws-sdk/client-s3`, `oci-distribution`, `simple-git`). Declare as optional peer deps.
7. **`failureModes`** — list the failures unique to this scheme (network timeout, 403, 404, digest mismatch, region misconfigured, missing token). The engine's `Remote-source failure-mode matrix` (see doc) must get a new row.

If any input is unclear, stop and ask. Do not invent defaults for auth or integrity — both have security implications.

## Files to generate

### 1. `src/sources/<scheme>-source.ts` — resolver class

- `@injectable({tags: {[ContractsBindings.SOURCE_TAG]: 'platform.contracts.source', scheme: '<scheme>'}})`
- `implements SchemaSource`
- Fields: `readonly scheme`, `readonly description`, `readonly peerDeps`, `readonly supportsDigest: boolean`.
- Method: `async fetch(uri: string, ctx: SourceContext): Promise<FetchedSchema>` — returns `{bytes, contentType, integrity, etag, fetchedAt, sourceUri}`.
- Method: `parseUri(uri: string): ParsedSourceUri` — validates the URI shape, extracts host/path/pin/digest.
- Throws typed errors (`SourceAuthError`, `SourceNotFoundError`, `SourceIntegrityError`) so the engine can map them to the failure-mode matrix.
- Mark the class and companion types `@experimental` in TSDoc until v1.x bump.

### 2. `src/sources/<scheme>-auth-extension.ts` — optional auth hook

- Only generate when `auth !== 'none'`.
- Defines an `AuthExtension<TCreds>` interface specific to the scheme (e.g. `S3AuthExtension`, `OciAuthExtension`).
- Resolver looks up bound auth extensions via `@extensions.view`. Default implementation reads env vars; users can bind their own (Vault, AWS SSO, k8s service account).

### 3. `src/sources/<scheme>-cache.ts` — caching plumbing (only if scheme-specific)

- Most resolvers use the engine's generic cache. Generate this file only when the scheme needs a custom cache key (e.g. OCI digest-addressed pulls bypass the URL cache and use the content-addressable layer cache).

### 4. `src/__tests__/integration/<scheme>-source.spec.ts` — integration stub

- vitest spec.
- Use a fixture server / in-memory mock (e.g. `nock` for HTTPS, `aws-sdk-client-mock` for S3, a local tarball for OCI).
- Cover at minimum: successful fetch, 404, auth failure, digest mismatch (if `supportsDigest`), timeout, and cache hit on second fetch.
- Mark with `describe.skipIf(process.env.CI_SKIP_NETWORK_TESTS)` only if the test genuinely needs the network.

### 5. `src/contracts.component.ts` — registration

- Add: `bindings = [createBindingFromClass(<Scheme>Source), ...];`
- If auth extension is present, document the binding key in the component docstring.

### 6. `README.md` — Schema sources table

- Add a row to the "Schema sources" table: `<scheme>://` | description | auth | integrity model | peer deps.
- Add a "When to use" subsection if the scheme has non-obvious trade-offs (e.g. OCI's digest pinning vs. tag mutability).

### 7. `package.json` — peer deps

- Add `peerDependencies` for SDK deps; mark optional via `peerDependenciesMeta` so users who don't use this scheme don't have to install them.

### 8. `loopback-contracts.md` — failure-mode matrix update

- Add a row to `### Remote-source failure-mode matrix` for the new scheme covering: transient failure, hard failure, integrity failure, auth failure, and CI behavior under `--frozen-lockfile`.

## Verification steps (run before declaring the skill done)

1. `npm run build` — resolver compiles cleanly.
2. `npm run lint` — no new violations.
3. `npm test -- <scheme>-source` — integration stub passes against the mock.
4. **CLI auto-pickup check:** run `lb4 init` and confirm the new scheme appears in the "Add a remote schema source now?" prompt's scheme picker.
5. Run `lb4 gen` against a fixture project with a `<scheme>://...` entry in `loopback.config.json` — confirm:
   - The fetch happens.
   - The result is cached (second `lb4 gen` is a cache hit).
   - The integrity field (if applicable) is written to the lockfile.
   - A digest-mismatch test causes a hard failure under `--frozen-lockfile`.
6. Run `lb4-public-api-audit` skill — confirm correct `@experimental` tagging on exported resolver types.

## Snags to watch for

- **Auth in URIs.** Never accept tokens embedded in the URI (e.g. `https://user:pass@host`). Force auth to flow through the `AuthExtension` so secrets don't end up in `loopback.config.json` or the lockfile.
- **Tag mutability vs. digest immutability.** If the scheme supports both (OCI, Git), the resolver MUST refuse to cache a tag-pinned fetch as if it were digest-pinned — the lockfile would be a lie.
- **Throwing untyped errors.** The failure-mode matrix maps typed errors to CI behavior. A generic `Error` becomes a 5xx-equivalent and may block `lb4 gen` unnecessarily. Always throw the typed error classes.
- **Forgetting `parseUri` validation.** A malformed URI must fail at parse time, not at fetch time, so `lb4 init` can validate the scheme without a network round-trip.
- **Cache key collisions.** Two URIs that resolve to the same content but differ in query order / case must produce the same cache key. Normalize in `parseUri`.
- **Network in unit tests.** Resolver unit tests must not hit the real network. Use mocks. Integration tests that need real endpoints must be gated behind an opt-in env var.
