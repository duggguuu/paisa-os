#!/usr/bin/env bash
# Publish the current app (HEAD) to the clean repo your partner forks from.
#
#   scripts/publish-for-partner.sh "What changed, in one line"
#
# Keeps a local clone of the clean repo next to this folder (../paisa-os-app), exports a clean copy
# into it (export-for-new-owner.sh: personal files and blocks removed, personal-data check), commits
# once and pushes. Nothing reaches her app until she taps "Sync fork" on her own copy.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLEAN_REPO="${CLEAN_REPO:-https://github.com/duggguuu/paisa-os-app.git}"
CLEAN_DIR="$ROOT/../paisa-os-app"
MESSAGE="${1:-Update $(date +%Y-%m-%d)}"

if [ ! -d "$CLEAN_DIR/.git" ]; then
  git -c credential.helper='!gh auth git-credential' clone -q "$CLEAN_REPO" "$CLEAN_DIR"
fi
git -C "$CLEAN_DIR" -c credential.helper='!gh auth git-credential' pull -q --ff-only origin main
"$ROOT/scripts/export-for-new-owner.sh" "$CLEAN_DIR" "$MESSAGE"
git -C "$CLEAN_DIR" -c credential.helper='!gh auth git-credential' push -q origin main
echo "Published. Your partner will see \"1 commit behind\" on her fork and can tap Sync fork."
