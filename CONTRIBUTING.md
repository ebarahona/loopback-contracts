# Contributing

Thanks for considering a contribution.

## Ground rules

- All commits must follow [Conventional Commits](https://www.conventionalcommits.org/).
- All commits must include a [DCO sign-off](https://developercertificate.org/) (`git commit -s`).
- All code must pass `npm run lint`, `npm run build`, and `npm test` before review.
- New code should follow [STYLE_GUIDE.md](./STYLE_GUIDE.md).

## AI coding agents

This repo carries cross-agent conventions in [`AGENTS.md`](./AGENTS.md). Claude Code, Codex CLI, Gemini CLI, Cursor, Cline, and Continue all read it. Whichever tool you use, point it at `AGENTS.md` and [`STYLE_GUIDE.md`](./STYLE_GUIDE.md) before writing code.

Claude Code users get seven invocable skills under `.claude/skills/` (slash commands `/conventional-commit`, `/lb4-plugin-review`, `/lb4-public-api-audit`, `/lb4-style-check`, `/pre-pr-check`, `/new-emitter`, `/new-source-resolver`). Other tools can read those `SKILL.md` files as plain Markdown and follow the instructions inline.

Agents must follow the same expectations as human contributors: Conventional Commits, DCO sign-off, passing lint+build+test, and no `any`/`@ts-ignore` suppressions.

## Local setup

Requires **Node.js >= 20.19.0**.

```bash
git clone https://github.com/ebarahona/loopback-contracts.git
cd loopback-contracts
npm install
npm run build
npm test
```

`npm install` runs the `prepare` script, which installs git hooks via lefthook (see [Git hooks](#git-hooks) below).

### Dev loop

The day-to-day inner loop for contract authors and emitter contributors:

```bash
npm run cli -- gen
```

Runs the engine end-to-end against the fixture project under `src/__tests__/fixtures/`. Add `--watch` for chokidar-driven regen on every save, or pass `--emit-<kind>` flags to exercise individual sidecar emitters. The same CLI binary ships as `lb-contracts` once the package is installed.

### Test scripts

| Script                     | Runs                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `npm test`                 | All tests (unit + integration), single-threaded                    |
| `npm run test:unit`        | Unit tests only (pure logic, no fs writes)                         |
| `npm run test:integration` | Integration tests only (full engine pipeline against fixture repo) |
| `npm run test:dev`         | Watch mode (vitest) for active development                         |

Integration tests run the engine end-to-end: source-resolver fetch, schema validation, meta-schema generation, all enabled emitters, file writer, and a final `tsc` of the produced bases.

## Commit message format

```
<type>(<scope>): <subject>

<body>

Signed-off-by: Your Name <you@example.com>
```

Allowed types: `build`, `chore`, `ci`, `deps`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, `style`, `test`.

Examples:

```
feat(engine): add x-emit-skip per-schema gating
fix(emitters): preserve discriminator on oneOf in Zod sidecar
docs(readme): document the eight-stage validation pipeline
feat(sources): add oci:// SOURCE_TAG resolver for artifact registries
```

## Pull requests

1. Branch from `main`. Keep the diff focused on a single change.
2. Add tests. Unit tests for pure logic (validation, registry, import-map resolution), integration tests for anything that touches the engine pipeline or writes files.
3. Contributions that add a new emitter or a new source resolver must include an integration test under `src/__tests__/integration/` that exercises the extension point end-to-end (binding registered, engine run, output asserted against a golden file).
4. Run `npm run lint && npm run build && npm test` before pushing. Claude Code users can run `/pre-pr-check` to do this plus commit-message validation in one step.
5. Open a PR. The [pull request template](./.github/PULL_REQUEST_TEMPLATE.md) auto-populates the form. Fill in the summary and test plan.
6. CI runs lint/build/test on Node 20/22/24, validates commit format, and checks DCO sign-off.

Issues use forms in [`.github/ISSUE_TEMPLATE/`](./.github/ISSUE_TEMPLATE/). Bug reports and feature requests have their own structured templates.

## Git hooks

Two paths cover identical checks:

- **Lefthook (default)**: `npm install` runs `scripts/install-hooks.sh`, which calls `lefthook install`. If lefthook can install cleanly, hooks run in parallel against staged files (fast). If lefthook is blocked by an existing `core.hooksPath` (yours or your dotfiles), the script prints opt-in instructions and exits without changing your git config. CI still enforces lint/build/test on every PR, so you can defer wiring local hooks.
- **Zero-dependency fallback**: for contributors who can't install lefthook. Wire native git to the shared scripts:
  ```bash
  git config --local core.hooksPath .githooks
  ```
  Same checks, sequential, runs over the whole tree.

Both paths are kept in sync by `src/__tests__/unit/hook-parity.spec.ts`. CI fails on drift.

## Help wanted

Several pieces of the plugin are scaffolded but waiting for community contribution: additional emitters, additional source resolvers, fixture schemas, and manifest-emitter templates for org-internal envelope formats. See [HELP_WANTED.md](./HELP_WANTED.md) for the open list and how to contribute.

## Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please). Maintainers do not tag manually. Once a release PR is merged, the workflow tags, publishes to npm, and updates `CHANGELOG.md`.

### Local `npm pack` / `npm publish` notes

Both commands run the `prepare` script as part of npm's lifecycle. The local hook installer (`scripts/install-hooks.sh`) detects `npm_command=pack` / `npm_command=publish` (and `--dry-run`) and skips silently in that context — no dev-onboarding nudge during a publish.

If `npm pack --dry-run` errors with `EACCES` against `~/.npm` (a stale-permission case from a previous `sudo npm install`), use a per-invocation cache instead of touching your global cache directory:

```bash
npm --cache /tmp/loopback-contracts-npm-cache pack --dry-run
# or for a real publish:
npm --cache /tmp/loopback-contracts-npm-cache publish
```

The repo does NOT ship an `.npmrc` overriding the cache — that would inflict a project-local cache on every contributor regardless of their setup. The `--cache` flag is the cleanest one-shot override that doesn't touch any global config.

## Branch protection (maintainer one-time setup)

These rules apply to `main` and are configured in the GitHub UI under `Settings -> Rules -> Rulesets` (or `Settings -> Branches -> Branch protection rules` on older repos). They are not in version control because GitHub does not yet support a workflow-managed rules file for personal repos.

- Require a pull request before merging (no direct pushes).
- Require status checks to pass: `Node 20 / ubuntu-latest`, `Node 22 / ubuntu-latest`, `Node 24 / ubuntu-latest`, `Conventional commits`, `DCO sign-off`, `CodeQL`, `Typos`, `Link check`, `Package size`.
- Require branches to be up to date before merging.
- Require linear history.
- Block force pushes.
- Block deletions.
- Restrict who can push to matching refs to the maintainer and the release-please bot.

Apply once. Future contributors will be unable to merge unless the full CI matrix is green.

## Documentation site

The API reference is generated by [TypeDoc](https://typedoc.org/) from the project's TSDoc and published to `https://ebarahona.github.io/loopback-contracts` on every push to `main` and every release. To preview locally:

```bash
npm run docs
open docs-site/index.html
```

The site is regenerated automatically; no maintainer action needed beyond merging.

To enable the published site on a fresh fork, set GitHub Pages source to `gh-pages` branch (repo settings -> Pages).

## Reporting bugs

Open a GitHub issue with:

- A minimal reproduction (one `schemas/<name>.schema.json` and the matching `configs/<name>.config.json`, plus the failing `lb4 gen` invocation).
- The plugin version, Node version, and a list of any `--emit-<kind>` flags in play.
- The full stack trace, including any Ajv `instancePath` pointers from validation failures.

## Security issues

See [SECURITY.md](./SECURITY.md). Do not file security reports as public issues.
