---
name: lb4-public-api-audit
description: Public API surface audit for any LoopBack 4 plugin. Plugin-agnostic. Reads the plugin's own `src/index.ts`, follows every export to its declaration, and checks stability tags (`@public` / `@experimental` / `@internal`), `export type` correctness, and internal-type-leak across the public signature graph. Use before a release or whenever exports are added.
---

# lb4-public-api-audit

Validate the public API surface declared by `src/index.ts`. Run before tagging a release, or whenever new exports are added. Drop-in: works in any LB4 plugin repo with a top-level `src/index.ts`.

## Read

```bash
git describe --tags --abbrev=0 2>/dev/null || echo "no previous tag"
```

Then:

- `src/index.ts` (current public surface).
- The declaration file of every exported symbol (follow each `export { Foo } from './...'` and `export type { Foo } from './...'`).
- The previous tag's `src/index.ts` if a tag exists: `git show $(git describe --tags --abbrev=0):src/index.ts`. Use it for the diff section. If no tag, treat all exports as "new for this release."
- LoopBack's [`loopback-core` skill](https://github.com/loopbackio/loopback-next/tree/master/skills/loopback-core) when encountering `@loopback/core` types in a public signature. Use it to determine whether a referenced upstream type is `@public` (acceptable in our public surface) or internal (treat as leak).

## Check

For every symbol exported from `src/index.ts`:

1. Has a JSDoc block at its declaration.
2. JSDoc contains exactly one of `@public`, `@experimental`, `@internal`.
3. Type-only exports use `export type { ... }` syntax in `src/index.ts`.
4. No symbol re-exports something whose declaration is marked `@internal`.
5. New exports (not in the previous tag's `index.ts`) default to `@experimental`. Promotion to `@public` is a semver commitment and must be intentional.
6. Removed exports since the previous tag — these are breaking changes; must align with a major version bump per Semantic Versioning.
7. Renamed exports — same as removed; flag.

For each `@public` symbol, additionally check:

- All parameter and return types are themselves exported or built-in (or upstream-`@public`). Internal types in a public signature are leaks.
- Generic type parameters have a `@template T` line in JSDoc.
- Methods returning `Promise<T>` document `@throws` for known error types.
- Async generators / observables that emit errors document the emit channel.

## Output

Two sections.

### Surface table

```
| Symbol            | Kind       | Stability     | Declared in                | Notes |
|-------------------|------------|---------------|----------------------------|-------|
| <ExportedSymbol>  | class      | @public       | src/path/to/file.ts        |       |
| <Type>            | type       | @experimental | src/path/to/types.ts       |       |
| ...               | ...        | ...           | ...                        | ...   |
```

`Notes` column flags any policy violation: `missing JSDoc`, `missing tag`, `internal type leak: <type>`, `re-exports internal: <symbol>`, `missing @template`, `missing @throws`.

### Diff summary

```
Added since <previous-tag>:
- <symbol> (@experimental)

Removed since <previous-tag>:
- <symbol> — BREAKING

Renamed since <previous-tag>:
- <old> -> <new> — BREAKING

Promoted @experimental -> @public:
- <symbol>

Demoted @public -> @experimental:
- <symbol> — BREAKING
```

If there's no previous tag, omit the diff section and note: `No previous release tag — this is the first audit.`

End with one of:

- `Public API is clean.` if no policy violations and no BREAKING entries (or BREAKING entries already accounted for by a pending major version bump in `package.json`).
- `Public API needs attention.` otherwise.

## Do not

- Do not modify code.
- Do not infer stability from naming — only the tag matters.
- Do not auto-promote `@experimental` to `@public` — flag candidates, let the maintainer decide.
- Do not check style violations — that's `lb4-style-check`.
