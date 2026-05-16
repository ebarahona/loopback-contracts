---
name: pre-pr-check
description: Pre-pull-request readiness check for any LoopBack 4 plugin. Plugin-agnostic. Runs lint, build, and test in order. Validates every commit message on the branch follows Conventional Commits. Verifies DCO sign-off on every commit. Scans the diff for STYLE_GUIDE.md drift. Outputs a PASS/FAIL checklist with a one-line fix for each fail.
---

# pre-pr-check

Verify the current branch is ready to open a PR against `main`. Plugin-agnostic — works in any repo that has `npm run lint`, `npm run build`, `npm test`, and a `STYLE_GUIDE.md`.

## Read

```bash
git status
git rev-parse --abbrev-ref HEAD
git diff main...HEAD --stat
git diff main...HEAD --name-only
```

If the current branch is `main`, abort and tell the user to switch to a feature branch.

## Run

In order, stop on first failure:

1. `npm run lint`
2. `npm run build`
3. `npm test`

For each: capture exit code and the last 20 lines of output for the report.

## Validate commits

```bash
npx commitlint --from main --to HEAD
git log main..HEAD --pretty=%B | grep -c '^Signed-off-by:'
git log main..HEAD --oneline | wc -l
```

The sign-off count must equal the commit count. Any commitlint failure is a FAIL.

## Scan diff for STYLE_GUIDE drift

For every `.ts` file under `src/` in the diff:

```bash
git diff main...HEAD -- 'src/**/*.ts' | grep -E '^\+' | grep -E 'export default'
git diff main...HEAD -- 'src/**/*.ts' | grep -E '^\+.*@ts-ignore'
git diff main...HEAD -- 'src/**/*.ts' | grep -E '^\+.*throw new Error\('
```

Cross-reference `src/index.ts` for new exports (`git diff main...HEAD -- src/index.ts`). For each new exported symbol, verify the declaration file has a JSDoc block containing one of `@public`, `@experimental`, `@internal`.

## Output

A checklist of seven items:

```
[PASS|FAIL] lint
[PASS|FAIL] build
[PASS|FAIL] test (N/M tests)
[PASS|FAIL] conventional commits (N commits validated)
[PASS|FAIL] DCO sign-off on every commit
[PASS|FAIL] no default exports / @ts-ignore / raw Error throws introduced
[PASS|FAIL] new public exports carry stability tag
```

For each FAIL, append a single line with the file:line (or the failing command) and the fix.

End with one of:

- `Ready to open PR.` if all pass.
- `Not ready — fix the FAILs above.` otherwise.

## Do not

- Do not push, do not open the PR, do not `git commit`. This skill reports state only.
- Do not auto-fix lint errors. The contributor should run `npm run lint -- --fix` themselves and re-run this skill.
- Do not skip `npm test` even if lint or build fails — capture the test state for the report.
- Do not invoke `lb4-plugin-review` or `lb4-public-api-audit` — those are separate skills the maintainer can run as deeper passes.
