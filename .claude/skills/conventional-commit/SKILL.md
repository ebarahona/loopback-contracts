---
name: conventional-commit
description: Author a Conventional Commits-formatted message with DCO sign-off for any LoopBack 4 plugin. Plugin-agnostic. Reads the staged diff, infers commit type, derives scope from the repo's own `src/` folder layout (not a hardcoded list), generates a subject line and body, and appends Signed-off-by. Never runs `git commit` itself.
---

# conventional-commit

Generate a Conventional Commits message for the currently staged changes. The message is the output — never invoke `git commit` from this skill.

## Read

```bash
git diff --cached --stat
git diff --cached
git config user.name
git config user.email
ls src 2>/dev/null   # to derive available scopes
```

If `git diff --cached` is empty, abort and tell the user to stage changes first.

## Decide

### Type

Pick a single Conventional Commits **type** from the staged diff:

- `feat` — new exports, new public methods, new BindingKeys, new lifecycle observers, new public-API surface
- `fix` — changes to existing logic that resolve a bug
- `docs` — changes only under `*.md` files or JSDoc-only edits
- `refactor` — code restructure with no behavior change
- `perf` — measurable performance improvement
- `test` — changes only under `__tests__/` or `*.spec.ts`
- `ci` — changes only under `.github/workflows/`
- `build` — changes to `package.json` (scripts), `tsconfig.json`, build configs
- `deps` — dependency version bumps only (`package.json` deps blocks, lockfile)
- `chore` — anything else

### Scope (derived from `src/` layout — not a hardcoded list)

Examine the dominant changed path. Use the first folder segment under `src/` as the scope. Examples (derived dynamically, not memorized):

- Files under `src/server/**` → scope `server`
- Files under `src/services/**` → scope `services`
- Files under `src/connector/**` → scope `connector`
- Files under `src/decorators/**` → scope `decorators`
- Files under `src/__tests__/**` → no scope (use bare type `test:`)
- `src/index.ts` alone → scope `index`
- `src/keys.ts` alone → scope `keys`
- `src/<name>.component.ts` → scope `component`
- `src/<name>.observer.ts` → scope `observer`

Scope is optional. Omit when the change spans many top-level `src/` subfolders or is repo-wide (lockfile bumps, CI workflows). Use a short kebab-case name when a folder name doesn't fit cleanly.

For multi-package monorepos, use the package name (e.g. `connector`, `transport-core`) as the scope; the within-package folder becomes context for the body.

## Write

Format:

```
<type>(<scope>): <subject>

<body>

Signed-off-by: <name> <email>
```

Rules:

- Subject line: under 72 chars, imperative mood, lowercase, no trailing period.
- Body: explain the _why_, not the _what_. Skip the body if the subject is fully self-explanatory.
- Reference an issue with `Refs #N` or `Fixes #N` in the body when applicable.
- Sign-off line uses the values from `git config user.name` and `git config user.email` verbatim.

## Output

Print the full message in a fenced code block, ready to paste into:

```bash
git commit -m "$(cat <<'EOF'
<message here>
EOF
)"
```

Then state the inferred type and scope on a single line so the contributor can sanity-check before pasting.

## Do not

- Do not run `git commit`. The user owns committing.
- Do not add `BREAKING CHANGE:` unless the diff actually breaks the public API in `src/index.ts` — that's a `feat!` / `fix!` decision the human should confirm.
- Do not invent issues, PR numbers, or co-authors.
- Do not hardcode scope names — derive them from the current repo's `src/` layout every invocation.
