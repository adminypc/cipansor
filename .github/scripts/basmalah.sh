#!/bin/sh
# Put the basmalah at the top of every issue and pull-request description.
#
# The owner asked (2026-10-13) that every main description open with
# «بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ» (transliterated
# `Bismillaahirrohmaanirrohiim`). The automations are told to open their own
# bodies with it; this workflow is the deterministic guarantee, so an issue a
# person files, or a body an automation forgot, still carries it.
#
# Idempotent: a body already opening with the basmalah (either script) is left
# alone, so editing a description does not stack a second copy. The scripts are
# the ones the issue forms and the automations use, so the check is exact.
#
# Usage: basmalah.sh --stdin          # an `opened`/`edited` webhook event
#        basmalah.sh <number>         # by hand
# Env:   GH_TOKEN, REPO (owner/name)
set -eu

REPO="${REPO:?REPO is required}"

# The two accepted openings. Arabic first (the automations), transliteration
# second (a person who cannot type Arabic).
ARABIC="بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ"
TRANSLIT="Bismillaahirrohmaanirrohiim"

if [ "${1:-}" = "--stdin" ]; then
  EVENT=$(cat)
  ACTION=$(printf '%s' "$EVENT" | jq -r '.action // empty')
  # A pull request's number is its issue number; the `pull_request_target`
  # payload names it under `.pull_request`, the `issues` payload under `.issue`.
  NUMBER=$(printf '%s' "$EVENT" | jq -r '.issue.number // .pull_request.number // empty')
else
  ACTION="opened"
  NUMBER="${1:?usage: basmalah.sh --stdin | <number>}"
fi

# Only for an opened or edited description; a `closed`/`labeled` event is not
# a reason to touch the body.
case "$ACTION" in
  opened | edited | reopened) ;;
  *) echo "action='$ACTION'; nothing to do."; exit 0 ;;
esac
[ -n "$NUMBER" ] || { echo "No issue number in the event; nothing to do."; exit 0; }

BODY=$(gh api "repos/$REPO/issues/$NUMBER" --jq '.body // ""' 2>/dev/null) \
  || { echo "::warning::could not read the body of #$NUMBER."; exit 0; }

# Already opens with one of the accepted lines (ignoring leading blank lines).
HEAD=$(printf '%s' "$BODY" | sed '/./,$!d' | head -n 1)
if [ "$HEAD" = "$ARABIC" ] || [ "$HEAD" = "$TRANSLIT" ]; then
  echo "#$NUMBER already opens with the basmalah; nothing to do."
  exit 0
fi

NEW="$ARABIC

$BODY"
# Assemble the JSON with jq (a body with quotes or newlines survives) and send
# it with --input, so the body is never mangled by shell word splitting.
TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
jq -n --arg body "$NEW" '{body: $body}' > "$TMP"
if ! gh api "repos/$REPO/issues/$NUMBER" -X PATCH --input "$TMP" >/dev/null 2>&1; then
  echo "::warning::could not prepend the basmalah to #$NUMBER."
  exit 0
fi
echo "Prepended the basmalah to #$NUMBER."
