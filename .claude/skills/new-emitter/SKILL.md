---
name: new-emitter
description: Scaffold a new ProjectionEmitter implementation end-to-end (TS class implementing ProjectionEmitter, @injectable({tags: {EMITTER_TAG, kind}}) registration, EJS template file under src/templates/, unit test stub, README mention, CLI flag auto-pickup verification). Use when adding a new built-in emitter or a project-local manifest emitter to @ebarahona/loopback-contracts. Marks the new exports `@experimental` until v1.x bump.
---

# new-emitter

Scaffold a new `ProjectionEmitter` end-to-end for `@ebarahona/loopback-contracts`. The engine discovers emitters via `@extensions.list({tag: EMITTER_TAG})`, so this skill produces every file the engine needs and verifies the CLI flag (`--emit-<kind>`), the init prompt, and the meta-schema enum auto-pick up the new emitter.

**Reference (read before scaffolding):**

- `/Users/ed/dev/oss/loopback-plugins/docs/contracts-extensibility.md` — full architecture, `ProjectionEmitter` interface, registration pattern, code-plugin vs. manifest path.
- `/Users/ed/dev/oss/loopback-plugins/docs/loopback-contracts.md` — `## Projections`, `### Extending — adding a new projection type`.

## When to use

- Adding a new built-in emitter to this plugin (e.g. `mock-data`, `cloudevents`, `proto`, `avro`).
- Adding a project-local manifest emitter (`emitters/<kind>.emitter.json` + a template).
- Adding a sibling-plugin emitter that ships in its own npm package.

Do NOT use this skill for changes to engine internals (pipeline, registry, file writer) — those are not emitters.

## Inputs the skill must collect from the user first

Ask the user explicitly and write the answers down before generating any file:

1. **`kind`** — string identifier. Drives `--emit-<kind>`, the config key, and the meta-schema enum entry. Lowercase, hyphenated, no spaces (e.g. `yup`, `cloudevents`, `mock-data`).
2. **`outputSuffix`** — file suffix the emitter writes (e.g. `.yup.ts`, `.cloudevents.json`).
3. **`tier`** — `core`, `sidecar`, or `extension`. Drives docs placement and default-on behavior.
4. **`description`** — one-liner shown in `lb4 init` prompts and `lb4 emitters list`.
5. **`peerDeps`** — npm packages the emitter's generated code depends on (e.g. `yup`, `graphql`). Will be declared as peer deps and surfaced in error messages when missing.
6. **`perSchemaOptionsSchema`** — JSON Schema (or `undefined`) for the `x-<kind>` block emitter authors may attach to source schemas. Engine validates source schemas against this when the emitter is active.
7. **Path** — built-in (`src/emitters/<kind>-emitter.ts`) or project-local manifest (`emitters/<kind>.emitter.json`)?

If any input is unclear or the user hasn't decided, stop and ask. Do not invent values.

## Files to generate

### 1. `src/emitters/<kind>-emitter.ts` — TS class

- `@injectable({tags: {[ContractsBindings.EMITTER_TAG]: 'platform.contracts.emitter', kind: '<kind>'}})`
- `implements ProjectionEmitter<TPerSchemaOptions>`
- Fields: `readonly kind`, `readonly outputSuffix`, `readonly tier`, `readonly description`, `readonly peerDeps`, `readonly perSchemaOptionsSchema`.
- `emit({schema, perSchemaOptions, importResolver, templates}: EmitterContext): EmittedFile[]` — single method that renders the template and returns `[{ relativePath, content, source }]`. Do not write files directly; the engine's file writer owns I/O.
- Mark the class and its companion types `@experimental` in their TSDoc until v1.x bump.

### 2. `src/templates/<kind>.ejs` — EJS template

- Use the same EJS engine LB4 uses (`templates.render(...)`).
- View-model variables must match what the class passes (typically `schema`, `imports`, `perSchemaOptions`).
- Keep template logic minimal — translation logic belongs in the TS class.

### 3. `src/__tests__/unit/<kind>-emitter.spec.ts` — vitest stub

- One fixture under `src/__tests__/fixtures/<kind>/input.schema.json`.
- One expected-output fixture under `src/__tests__/fixtures/<kind>/expected.<outputSuffix>`.
- Test: instantiate the emitter, call `emit()` with a stub `EmitterContext`, assert the rendered output equals the expected fixture.
- Do not test engine internals; emitter tests must depend only on the public `ProjectionEmitter` interface and `EmitterContext` shape.

### 4. `src/contracts.component.ts` — registration

- Add the emitter to the component's `bindings`:
  ```ts
  bindings = [createBindingFromClass(<Kind>Emitter), ...];
  ```
- If the emitter has peer deps, declare them in the component's docstring and `peerDependencies` in `package.json`.

### 5. `README.md` — emit-flags table

- Add a row to the "Supported emitters" / "Emit flags" table: `--emit-<kind>` | description | tier | peer deps.
- Add a one-paragraph "When to enable" note in the appropriate Projections section.

### 6. `package.json` — peer deps (if applicable)

- Add `peerDependencies` entries for emitter peer deps.
- Add `peerDependenciesMeta: {<dep>: {optional: true}}` so installs don't fail when the emitter isn't enabled.

## Verification steps (run before declaring the skill done)

1. `npm run build` — emitter compiles cleanly.
2. `npm run lint` — no new violations.
3. `npm test -- <kind>-emitter` — the unit test fixture round-trips.
4. **CLI auto-pickup check:** run `lb4 gen --emit-<kind>` against a fixture project; confirm:
   - The flag is accepted (no "unknown flag" error).
   - The output file appears at the expected path with the right suffix.
   - The generated `_meta/emitter-config.schema.json` enum includes the new kind.
   - `lb4 init` shows the new emitter in the sidecar-emissions multi-select.
5. Run `lb4-public-api-audit` skill if the emitter or its types are exported from `src/index.ts` — confirm correct `@experimental` tagging.

## Snags to watch for

- **Forgetting the binding tag value.** The tag value must be the string `'platform.contracts.emitter'`, not just the constant name. The engine queries by tag value.
- **Mutating `EmitterContext.schema`.** The context is shared across emitters in a single run. Treat it as immutable.
- **Writing files from `emit()`.** Return `EmittedFile[]`; the engine writes. Direct I/O breaks the dry-run mode and the diff preview.
- **Template path drift.** `src/templates/<kind>.ejs` must be copied to `dist/templates/` by the build. Verify `package.json` `files` glob and the TS build copies non-TS assets.
- **Missing `perSchemaOptionsSchema`.** If the emitter reads `x-<kind>` blocks from source schemas, the schema MUST be declared so the engine can validate at gate 3 (per-emitter source-schema validation).
