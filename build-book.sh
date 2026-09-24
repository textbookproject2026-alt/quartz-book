#!/usr/bin/env bash
#
# build-book.sh — build one platform book with the shared Quartz (BOOK-ONE-TO-QUARTZ §0).
#
#   ./build-book.sh <book checkout> --branch <branch> [--preview] [--out <dir>] [--registry <registry.json>]
#
#   <book checkout>  a git checkout of the book's repo, at the commit to build.
#                    It is only read: Quartz builds from a copy.
#   --branch         the branch this build is for. The live branch gets a normal
#                    site; any other branch is a preview with X-Robots-Tag: noindex.
#   --preview        noindex even on the live branch: a design preview (§4b)
#                    of the live branch, deployed beside it, not in its place.
#   --out            where the site goes (default: ./public). Emptied first.
#   --registry       a registry.json to use instead of fetching the registry's main.
#
# Exit status: 0 built; 2 refused (a retired or unknown book, a dirty checkout,
# a clash with /how-to-comment, or a published file outside the allowlist);
# anything else is a failure of the build itself.
#
# Needs `npm ci` and `npx quartz plugin install` to have been run in this repo.
set -euo pipefail

usage() { sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

BUILDER="$(cd "$(dirname "$0")" && pwd)"
BOOK="" BRANCH="" OUT="$BUILDER/public" REGISTRY="" PREVIEW=""
while [ $# -gt 0 ]; do
  case "$1" in
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --preview) PREVIEW=1; shift ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --registry) REGISTRY="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift 2 ;;
    -h|--help) usage ;;
    -*) echo "build-book: unknown option $1" >&2; usage ;;
    *) [ -z "$BOOK" ] || usage; BOOK="$1"; shift ;;
  esac
done
[ -n "$BOOK" ] && [ -n "$BRANCH" ] || usage
BOOK="$(cd "$BOOK" && pwd)"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

if [ ! -d "$BUILDER/.quartz/plugins/edition-integrations" ]; then
  echo "build-book: plugins are not installed. Run: npm ci && npx quartz plugin install" >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/quartz-book.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

# 1. The registry, the refusals, the staged copy and this book's config.
PREVIEW="$PREVIEW" node "$BUILDER/builder/prepare.mjs" "$BOOK" "$BRANCH" "$WORK" ${REGISTRY:+"$REGISTRY"}

# 2. Quartz. It reads quartz.config.yaml from its working directory only, so
#    the build runs in a directory that holds the book's rendered config and
#    links everything else back to this repo.
RUN="$WORK/run"
mkdir "$RUN"
for f in quartz node_modules .quartz package.json package-lock.json tsconfig.json quartz.ts \
         globals.d.ts index.d.ts quartz.lock.json; do
  ln -s "$BUILDER/$f" "$RUN/$f"
done
mv "$WORK/quartz.config.yaml" "$RUN/quartz.config.yaml"
rm -rf "$OUT"
(cd "$RUN" && npx quartz build -d "$WORK/content" -o "$OUT")

# 3. The builder's additions, and the check that nothing else was published.
node "$BUILDER/builder/finish.mjs" "$WORK" "$OUT"
