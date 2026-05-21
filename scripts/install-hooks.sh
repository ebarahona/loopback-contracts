#!/bin/sh
# Auto-runs from `npm install` via the `prepare` script.
#
# Never modifies your git config (local or global). If lefthook can't
# install because you have a `core.hooksPath` set (global or local),
# prints opt-in instructions and exits successfully so `npm install`
# does not fail.
#
# CI runs lint/build/test on every PR regardless of local hooks, so
# skipping the local install is safe -- just slower feedback.

# Skip entirely on CI: no need to install git hooks in an ephemeral
# runner, and lefthook's platform-specific subpackage may not be
# resolved when the lockfile is missing cross-platform optional deps.
if [ -n "$CI" ]; then
  exit 0
fi

# Skip during `npm pack` / `npm publish` (including `--dry-run`).
# `prepare` is also invoked by those commands, but there's nothing to
# opt into at publish time -- and the opt-in nudge below is pure noise
# in that context. npm 7+ sets `npm_command` to the top-level
# subcommand; older versions don't, so we also check the
# `npm_config_dry_run` flag as a belt-and-suspenders signal.
case "$npm_command" in
  pack|publish)
    exit 0
    ;;
esac
if [ "$npm_config_dry_run" = "true" ]; then
  exit 0
fi

if npx lefthook install; then
  exit 0
fi

cat <<'EOF' >&2

----------------------------------------------------------------------
note: lefthook could not install hooks automatically.

This usually means you have a `core.hooksPath` configured globally
(e.g. by your dotfiles or your employer). We did NOT change your git
config -- your existing hooks are untouched.

If you'd like this repo's lint/format/typecheck/commitlint hooks to
fire in addition, opt in locally. Both options affect THIS clone
only and can be reversed with `git config --local --unset core.hooksPath`.

  # Lefthook path (parallel, staged-files-aware, requires `npx lefthook`):
  git config --local core.hooksPath .git/hooks
  npx lefthook install --force

  # Zero-dependency fallback (sequential, whole-tree, no lefthook needed):
  git config --local core.hooksPath .githooks

Either one shadows your global hooks for this clone only. Pick the
trade-off you prefer.
----------------------------------------------------------------------

EOF
exit 0
