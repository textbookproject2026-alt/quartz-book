#!/usr/bin/env bash
# fetch-fonts.sh <dir>: the downloads' fonts (export-tools, above), each family's
# static faces and its OFL licence in <dir>/<family>/, from pinned upstream
# releases checked by sha256. Also runs locally: TB_FONTS=<dir> for build-book.sh.
set -euo pipefail
DIR="${1:?usage: fetch-fonts.sh <dir>}"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP:?}"' EXIT
mkdir -p "$DIR"

get() { # url sha256 file
  curl -sfLo "$TMP/$3" "$1"
  if command -v sha256sum >/dev/null; then echo "$2  $TMP/$3" | sha256sum -c - >/dev/null
  else echo "$2  $TMP/$3" | shasum -a 256 -c - >/dev/null; fi
}
FACES="Regular It Semibold SemiboldIt Bold BoldIt"

# Source Serif 4, 4.005R: the Desktop zip's static OTFs and LICENSE.md.
get https://github.com/adobe-fonts/source-serif/releases/download/4.005R/source-serif-4.005_Desktop.zip \
  549fdb8f9a682bd06944298621404969f6de77c2e422ff3b8244a1dcd6a0c425 serif.zip
unzip -q -o "$TMP/serif.zip" -d "$TMP/serif"
mkdir -p "$DIR/source-serif-4"
for f in $FACES; do cp "$TMP/serif/source-serif-4.005_Desktop/OTF/SourceSerif4-$f.otf" "$DIR/source-serif-4/"; done
cp "$TMP/serif/source-serif-4.005_Desktop/LICENSE.md" "$DIR/source-serif-4/OFL.md"

# Source Sans 3, 3.052R: the OTF zip; its licence from the repository at that tag.
get https://github.com/adobe-fonts/source-sans/releases/download/3.052R/OTF-source-sans-3.052R.zip \
  a4ebbdea20b08ccbd7bf3665a9462454eefdd01d9a6307129d3b3d4672981074 sans.zip
get https://raw.githubusercontent.com/adobe-fonts/source-sans/3.052R/LICENSE.md \
  89ad2c4f66dd29127527493e729c31e731f111cf10faf5774c3db9275ed0c22c sans-licence.md
unzip -q -o "$TMP/sans.zip" -d "$TMP/sans"
mkdir -p "$DIR/source-sans-3"
for f in $FACES; do cp "$TMP/sans/OTF/SourceSans3-$f.otf" "$DIR/source-sans-3/"; done
cp "$TMP/sans-licence.md" "$DIR/source-sans-3/OFL.md"

# JetBrains Mono, 2.304: its static TTFs and OFL.txt.
get https://github.com/JetBrains/JetBrainsMono/releases/download/v2.304/JetBrainsMono-2.304.zip \
  6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf mono.zip
unzip -q -o "$TMP/mono.zip" -d "$TMP/mono"
mkdir -p "$DIR/jetbrains-mono"
for f in Regular Italic SemiBold SemiBoldItalic Bold BoldItalic; do cp "$TMP/mono/fonts/ttf/JetBrainsMono-$f.ttf" "$DIR/jetbrains-mono/"; done
cp "$TMP/mono/OFL.txt" "$DIR/jetbrains-mono/OFL.txt"
echo "fonts: Source Serif 4, Source Sans 3, JetBrains Mono in $DIR"
