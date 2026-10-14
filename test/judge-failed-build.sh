#!/usr/bin/env bash
# A book's build failed in CI (ci.yml, design-preview.yml): whose fault is it?
#
#   test/judge-failed-build.sh <book checkout> <slug> <build-book.sh arguments after the checkout…>
#
# Builds the same checkout with the builder at the `stable` tag. If that fails
# too, the book's own content stops it, not the builder being tested: a warning,
# exit 0, so one book never holds up the builder for every book (14 Oct). If
# stable builds it, the builder under test broke it: an error, exit 1.
set -euo pipefail
BOOK="$1" SLUG="$2"; shift 2
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STABLE="${RUNNER_TEMP:-${TMPDIR:-/tmp}}/stable-builder"
git -C "$HERE" fetch --quiet --force --depth=1 origin "+refs/tags/stable:refs/tags/stable"
rm -rf "$STABLE"
git -C "$HERE" worktree add --quiet --detach "$STABLE" stable
cd "$STABLE"
npm ci --silent >/dev/null && npx quartz plugin install >/dev/null
# The same arguments, with --out moved aside so the failed build stays as it was.
args=()
while [ $# -gt 0 ]; do
  if [ "$1" = --out ]; then args+=(--out "$STABLE/site"); shift 2; else args+=("$1"); shift; fi
done
if ./build-book.sh "$BOOK" "${args[@]}"; then
  echo "::error::$SLUG builds with the builder at stable but not with this one: a builder regression."
  exit 1
fi
echo "::warning::$SLUG doesn't build with the builder at stable either, so its own content stops it, not this builder. Its site keeps its last build, and the other books are unaffected; the checks that need its build are skipped."
