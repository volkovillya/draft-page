#!/usr/bin/env bash
# Fails when a banned name appears in tracked files or a commit message.
# The names are private: one per line in .git/info/banned-names (local), or a
# `|`-separated list in $BANNED_NAMES_PATTERN (CI secret). Matches are whole-word
# and case-insensitive. Only file:line is printed, never the matched text.
#
#   check-banned-names.sh --staged        files as staged for the next commit (pre-commit hook)
#   check-banned-names.sh --all           tracked files in the working tree (CI)
#   check-banned-names.sh --message FILE  a commit message (commit-msg hook)
set -euo pipefail

mode="${1:-}"
root="$(git rev-parse --show-toplevel)"
names_file="$(git rev-parse --git-path info/banned-names)"
[[ "$names_file" = /* ]] || names_file="$root/$names_file"

pattern="${BANNED_NAMES_PATTERN:-}"
if [[ -z "$pattern" && -f "$names_file" ]]; then
  pattern="$(grep -v '^[[:space:]]*\(#\|$\)' "$names_file" | tr -d '\r' | paste -sd '|' -)"
fi
if [[ -z "$pattern" ]]; then
  echo "check-banned-names: no names configured (add them to $names_file or set BANNED_NAMES_PATTERN)" >&2
  exit 2
fi

case "$mode" in
  --staged) hits="$(git -C "$root" grep --cached -I -i -w -n -E "$pattern" | cut -d: -f1,2 || true)" ;;
  --all) hits="$(git -C "$root" grep -I -i -w -n -E "$pattern" | cut -d: -f1,2 || true)" ;;
  --message)
    [[ -f "${2:-}" ]] || { echo "check-banned-names: --message needs a file" >&2; exit 2; }
    hits="$(grep -v '^#' "$2" | grep -i -w -n -E "$pattern" | cut -d: -f1 | sed 's/^/commit message line /' || true)"
    ;;
  *) echo "usage: $0 --staged | --all | --message FILE" >&2; exit 2 ;;
esac

if [[ -n "$hits" ]]; then
  echo "check-banned-names: a banned name was found at:" >&2
  echo "$hits" >&2
  exit 1
fi
