---
name: lb4-style-check
description: Mechanical style-guide compliance check for any LoopBack 4 plugin. Plugin-agnostic. Runs against the modified `.ts` files under `src/` and flags deterministic violations of the canonical LB4 plugin STYLE_GUIDE.md rules. Fast first pass before `lb4-plugin-review`. Suggests `npm run lint -- --fix` for auto-fixable violations.
---

# lb4-style-check

Mechanical, rule-based style-guide enforcement for any LoopBack 4 plugin. No judgment, no design feedback — that's `lb4-plugin-review`'s job. Drop-in: works in any plugin repo that has a `STYLE_GUIDE.md` and a TypeScript `src/` tree.

## Read

```bash
git diff <baseline>..HEAD --name-only -- 'src/**/*.ts'
git diff --name-only -- 'src/**/*.ts'  # uncommitted, if any
```

Default `<baseline>` is `origin/main`. If `origin/main` is local-only ahead, use the latest tag. If neither exists (fresh repo), check the entire `src/**/*.ts` tree.

Read `STYLE_GUIDE.md` once for the rule list. Then read every `.ts` file the diff touches.

## Check

For each modified `.ts` file under `src/`, flag any of:

- `export default` anywhere — STYLE_GUIDE says named exports only.
- `import { Foo } from '...'` where `Foo` is used only as a type — must be `import type`.
- Type assertion in angle-bracket form `<Foo>x` — must be `x as Foo`.
- `==` or `!=` — must be `===`/`!==`. Allowed exception: `x == null` to cover `undefined`.
- A `switch` without a `default:` case.
- `@ts-ignore` — must be `@ts-expect-error` with a `// reason: ...` description.
- Exported symbol from `src/index.ts` whose declaration lacks `@public` / `@experimental` / `@internal`.
- File name that doesn't match LB4 dot-kebab convention (`*.controller.ts`, `*.service.ts`, `*.repository.ts`, `*.model.ts`, `*.datasource.ts`, `*.component.ts`, `*.observer.ts`, `*.interceptor.ts`, `*.provider.ts`). Helper files under `src/helpers/` and `src/__tests__/**` are exempt; pure utility files in any subfolder may also use plain kebab-case (`connection-manager.ts`, `query-builder.ts`).
- `throw new Error(...)` for a domain failure — STYLE_GUIDE §13 requires `<Domain>Error` subclass. Skip if it's clearly a programmer-error guard (e.g. `throw new Error('unreachable')`).

## Output

A bulleted list, one violation per line:

```
- src/path/to/file.ts:42 — <rule violated> — <one-line fix>
```

No prose, no headers, no severity grouping. If everything passes:

```
No style-guide violations on the changed surface.
```

If any violations would be auto-fixed by ESLint (`consistent-type-imports`, `consistent-type-assertions`, `default-case`, `eqeqeq`, `import/no-default-export`, `ban-ts-comment`), append a single line at the bottom:

```
Run `npm run lint -- --fix` to auto-fix N of M violations.
```

## Do not

- Do not edit code. This skill is read-only.
- Do not flag design or architecture concerns — that's `lb4-plugin-review`.
- Do not check driver/SDK usage — that's `lb4-plugin-review`'s `{SKILL_DOMAIN}` stage.
- Do not check commit messages — that's `pre-pr-check` / `conventional-commit`.
