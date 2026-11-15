#!/usr/bin/env bash
# Make a clean copy of Paisa OS for someone to run on their OWN accounts (GitHub + Neon + Render).
#
#   scripts/export-for-new-owner.sh <target-folder>
#
# The copy is the last commit (HEAD) without anything personal: no git history, no sheet snapshot,
# no personal OCR fixture, no owner notes. It fails if any personal string is still in it.
# It contains code only: data lives in each owner's own database and never travels with the code.
set -euo pipefail

TARGET="${1:?usage: scripts/export-for-new-owner.sh <target-folder>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -e "$TARGET" ]; then echo "Refusing: $TARGET already exists." >&2; exit 1; fi
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then echo "Commit your changes first (the export is made from HEAD)." >&2; exit 1; fi

mkdir -p "$TARGET"
git -C "$ROOT" archive HEAD | tar -x -C "$TARGET"
cd "$TARGET"

# Personal files.
rm -f apps/api/data/stuff-sheet.json apps/web/test/hm-ocr.json
rmdir apps/api/data 2>/dev/null || true
# The owner's notes become the new owner's guide.
mv docs/NEW-OWNER.md README.md
sed -i.bak \
  -e 's/of the private repo `[^`]*`/of your private GitHub repo/' \
  -e "s/ The 'Yash's Stuff' Claude Sheet can't be reached from the server; Claude syncs it through the Claude Docs connector when asked\.//" \
  CLAUDE.md
# Comment-only change in a migration (safe: a new owner's database has never applied the original).
sed -i.bak -e "s/Mirrors the \"Yash's Stuff\" sheet/Mirrors a wardrobe sheet/" db/migrations/005_stuff.sql
rm -f CLAUDE.md.bak db/migrations/005_stuff.sql.bak
rm -f scripts/export-for-new-owner.sh
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

git init -q -b main
git add -A
git -c user.name="Paisa OS" -c user.email="paisa@localhost" commit -q -m "Paisa OS"
echo "Clean copy ready in $TARGET ($(git ls-files | wc -l | tr -d ' ') files). Hand over the folder; see README.md."
