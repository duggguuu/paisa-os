#!/usr/bin/env bash
# Make (or update) a clean copy of Paisa OS for someone to run on their OWN accounts (GitHub + Neon + Render).
#
#   scripts/export-for-new-owner.sh <target-folder> ["commit message"]
#
#  - <target-folder> doesn't exist: creates it as a new git repo with one commit.
#  - <target-folder> is a git repo (e.g. a clone of the clean repo): replaces its files with the new
#    clean copy and adds ONE new commit. History from this (the owner's) repo never goes there.
#
# The copy is the last commit (HEAD) without anything personal: no sheet snapshot, no personal OCR
# fixture, no owner notes, no blocks marked <personal>. It fails if anything listed in the local,
# never-committed scripts/.personal-patterns is still present. Code only: data lives in each owner's
# own database and never travels with the code.
set -euo pipefail

TARGET="${1:?usage: scripts/export-for-new-owner.sh <target-folder> [\"commit message\"]}"
MESSAGE="${2:-Update $(date +%Y-%m-%d)}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -e "$TARGET" ] && [ ! -d "$TARGET/.git" ]; then echo "Refusing: $TARGET exists and isn't a git repo." >&2; exit 1; fi
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then echo "Commit your changes first (the export is made from HEAD)." >&2; exit 1; fi

BUILD="$(mktemp -d)"
trap 'rm -rf "$BUILD"' EXIT
git -C "$ROOT" archive HEAD | tar -x -C "$BUILD"
cd "$BUILD"

# Personal files.
rm -f apps/api/data/stuff-sheet.json apps/web/test/hm-ocr.json
rmdir apps/api/data 2>/dev/null || true
# The owner's notes become the new owner's guide.
mv docs/NEW-OWNER.md README.md
rmdir docs 2>/dev/null || true
sed -i.bak \
  -e 's/of the private repo `[^`]*`/of your private GitHub repo/' \
  -e "s/ The 'Yash's Stuff' Claude Sheet can't be reached from the server; Claude syncs it through the Claude Docs connector when asked\.//" \
  CLAUDE.md
# Comment-only change in a migration (safe: a new owner's database has never applied the original).
sed -i.bak -e "s/Mirrors the \"Yash's Stuff\" sheet/Mirrors a wardrobe sheet/" db/migrations/005_stuff.sql
rm -f CLAUDE.md.bak db/migrations/005_stuff.sql.bak
# Owner-only tooling.
rm -f scripts/export-for-new-owner.sh scripts/publish-for-partner.sh
rmdir scripts 2>/dev/null || true
# Strip everything marked as the owner's own: whole blocks (// <personal> … // </personal>) and
# inline lists (/*<personal>*/ … /*</personal>*/), e.g. tests built on the owner's real order.
find apps -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.mjs' \) -print0 | xargs -0 perl -0pi -e 's{^[ \t]*// <personal>.*?^[ \t]*// </personal>[^\n]*\n}{}gms; s{/\*<personal>\*/.*?/\*</personal>\*/\s*}{}gs'

# Last line of defence: nothing personal may remain. The owner's own words and figures (name, IDs,
# employer, pay, loans…) live in scripts/.personal-patterns, one regex per line. That file is never
# committed, so the repository itself holds none of them. package-lock.json is skipped (random hashes).
PATTERNS_FILE="$ROOT/scripts/.personal-patterns"
if [ ! -s "$PATTERNS_FILE" ]; then echo "Refusing: $PATTERNS_FILE is missing (it lists what must never be exported)." >&2; exit 1; fi
PERSONAL="$(grep -v '^[[:space:]]*\(#\|$\)' "$PATTERNS_FILE" | paste -sd'|' -)|<personal>"
if grep -rIl -i -E --exclude=package-lock.json "$PERSONAL" . ; then
  echo "Refusing: personal data found in the files above." >&2
  exit 1
fi
# Also refuse anything that isn't code or the app's own icons.
STRAY="$(find . -type f ! -path './.git/*' | grep -vE '\.(ts|tsx|mjs|js|css|sql|md|json|html|yaml|yml|example|webmanifest|png)$|/\.gitignore$' || true)"
if [ -n "$STRAY" ]; then echo "Refusing: unexpected files in the export:" >&2; echo "$STRAY" >&2; exit 1; fi

COMMIT=(-c user.name="Paisa OS" -c user.email="paisa@localhost" commit -q -m "$MESSAGE")
if [ -d "$TARGET/.git" ]; then
  rsync -a --delete --exclude .git "$BUILD"/ "$TARGET"/
  cd "$TARGET"
  git add -A
  if git diff --cached --quiet; then echo "No changes: $TARGET is already up to date."; exit 0; fi
  git "${COMMIT[@]}"
  echo "Updated $TARGET with one new commit: $MESSAGE"
else
  mkdir -p "$TARGET"
  rsync -a "$BUILD"/ "$TARGET"/
  cd "$TARGET"
  git init -q -b main
  git add -A
  git -c user.name="Paisa OS" -c user.email="paisa@localhost" commit -q -m "Paisa OS"
  echo "Clean copy ready in $TARGET ($(git ls-files | wc -l | tr -d ' ') files). See README.md."
fi
