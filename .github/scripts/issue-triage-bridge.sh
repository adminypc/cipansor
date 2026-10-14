#!/bin/sh
# Dispatch the issue triage owner when another automation has responded, or when
# an open, not-`ready` issue has new activity.
#
# Why this exists: nothing in the fleet fires on `issues.edited`, so a reporter
# who edits an issue description gets no re-triage (found on #818, whose body was
# edited twice after triage with no answer). The triage owner is instead
# dispatched deterministically by this bridge:
#
#   --stdin   a bot applies a type or priority label — the labeler responded, so
#             the triage owner studies the issue and the bot's comment
#   --sweep   an open, not-`ready` issue has activity newer than the fleet's last
#             write — this catches an edited description or a new comment without
#             a trigger on `issues.edited`
#
# Both paths key on the timestamp of the fleet's last write about triage: the
# triage owner's `<!-- sdlc:triase -->` comment, or any `triage-bridge` marker
# comment. When the issue's `updated_at` is strictly newer than that, someone
# else acted and the owner is dispatched. No time margin is used: a marker
# written by this bridge moves `updated_at` to its own creation instant, so the
# two are equal and the bridge does not trigger itself, while a reporter edit a
# few seconds later is strictly newer and is caught (the old 60-second margin
# swallowed edits made just after a triage — reported on #818's follow-up).
#
# An issue whose summary lives in the body with no marker comment (triaged
# before this bridge existed) has no fleet timestamp, so it is dispatched once as
# a migration and given a marker; the body marker is never a reason to skip it.
#
# A marker comment is recorded only after the dispatch is accepted (HTTP 2xx).
# A failed dispatch leaves no marker, so the next sweep retries it and the run
# fails loudly instead of looking like a quiet, completed sweep.
#
# The triage owner is idempotent (one comment per round, updated in place), so a
# duplicate dispatch is not a duplicate comment — the markers exist to save runs.
#
# Usage: issue-triage-bridge.sh --stdin
#        issue-triage-bridge.sh --sweep
# Env:   GH_TOKEN, REPO, OPENHANDS_API_KEY, SDLC_TRIAGE_ID (default `SDLC 01`),
#        CURL (default curl), SWEEP_MAX (default 15, dispatches per sweep),
#        SWEEP_PAGES (default 5, search pages of 100 read per sweep),
#        BURST_WINDOW (default 300, seconds a label burst stays collapsed)
set -eu

REPO="${REPO:?REPO is required}"
# `SDLC 01 · Triase bug`. Overridable so a redeploy that moves the id does not
# need a workflow edit.
TRIAGE_ID="${SDLC_TRIAGE_ID:-d648595e-b0d9-4120-bbc4-07395cdbe6bf}"
API="https://app.all-hands.dev/api/automation/v1"
CURL="${CURL:-curl}"
TYPE_LABELS="bug enhancement documentation refactor chore security"
# SWEEP_MAX caps dispatches (cost), not pages: the sweep reads every page, sorts
# by activity, then stops dispatching after SWEEP_MAX so the freshest issues go
# first and the rest wait for the next run.
SWEEP_MAX="${SWEEP_MAX:-15}"
SWEEP_PAGES="${SWEEP_PAGES:-5}"
# The labeler applies type, priority and status in one burst; a marker younger
# than this collapses the burst to one dispatch. A later change to a type or
# priority the issue held before still dispatches once the window has passed.
BURST_WINDOW="${BURST_WINDOW:-300}"
# Every marker comment carries the AI-disclosure footer: without it a
# comment-triggered automation (Penjernih issue on `needs-info`, or
# acknowledge.yml) would read the marker as a reporter's reply and fire.
FOOTER="_This comment was created by an AI agent (OpenHands) on behalf of the repository maintainers._"
MARK_PREFIX="<!-- triage-bridge-sweep:"

epoch() { date -u -d "$1" +%s 2>/dev/null || echo 0; }

# Dispatch the triage owner for one issue. The body is built with jq so an issue
# number or a marker can never break out of its JSON string. Returns non-zero on
# a non-2xx answer so the caller can withhold the marker and retry later.
dispatch() { # dispatch <number> <reason> <key>
  n="$1"; reason="$2"; key="$3"
  if [ -z "${OPENHANDS_API_KEY:-}" ]; then
    echo "::error::OPENHANDS_API_KEY is not set; the triage owner cannot be dispatched for #$n."
    return 1
  fi
  body=$(jq -n --arg source triage-bridge --argjson issue "$n" \
    --arg reason "$reason" --arg key "$key" \
    '{source: $source, issue: $issue, reason: $reason, key: $key}')
  code=$("$CURL" -s -o /tmp/triage-bridge.out -w '%{http_code}' -X POST \
    "$API/$TRIAGE_ID/dispatch" \
    -H "Authorization: Bearer $OPENHANDS_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body")
  cat /tmp/triage-bridge.out 2>/dev/null; echo
  # A dispatch that is not accepted must be visible and retryable: a silent
  # triage is the failure this bridge exists to prevent.
  case "$code" in
    2??) echo "Dispatched the triage owner for #$n ($reason, HTTP $code)." ;;
    *) echo "::error::Dispatching the triage owner for #$n failed (HTTP $code)."; return 1 ;;
  esac
}

# The marker for the issue's current type+priority state. Keyed on the labels so
# a label burst collapses to one dispatch while a real change re-dispatches.
state_marker() { # state_marker <number>
  n="$1"
  state=$(gh api "repos/$REPO/issues/$n" \
    --jq '[.labels[].name | select(test("^(bug|enhancement|documentation|refactor|chore|security)$") or startswith("priority:"))] | sort | join("+")' \
    2>/dev/null || echo "")
  [ -n "$state" ] || state="none"
  echo "<!-- triage-bridge:$n:$state -->"
}

has_comment() { # has_comment <number> <marker>
  n="$1"; m="$2"
  gh api --paginate "repos/$REPO/issues/$n/comments?per_page=100" --jq '.[].body' 2>/dev/null \
    | grep -Fq -- "$m"
}

# The state marker's `updated_at`, or "" when it is absent.
state_marker_age() { # state_marker_age <number> <marker>
  gh api --paginate "repos/$REPO/issues/$1/comments?per_page=100" \
    --jq "[.[] | select(.body | contains(\"$2\")) | .updated_at] | max // \"\"" \
    2>/dev/null || echo ""
}

post_marker() { # post_marker <number> <marker>
  n="$1"; m="$2"
  tmp=$(mktemp)
  # The marker stays greppable (has_comment matches it as a substring); the
  # footer is appended so the marker is not mistaken for a reporter's reply.
  jq -n --arg body "$m

$FOOTER" '{body: $body}' > "$tmp"
  gh api "repos/$REPO/issues/$n/comments" -X POST --input "$tmp" >/dev/null 2>&1 \
    || echo "::warning::could not record the triage-bridge marker on #$n."
  rm -f "$tmp"
}

# The single sweep marker comment on the issue (created once, edited in place).
write_sweep_marker() { # write_sweep_marker <number>
  n="$1"; at="$2"
  cid=$(gh api --paginate "repos/$REPO/issues/$n/comments?per_page=100" \
    --jq "[.[] | select(.body | startswith(\"$MARK_PREFIX\"))] | last | .id // \"\"" 2>/dev/null || echo "")
  tmp=$(mktemp)
  # The stamp changes on every write so GitHub actually bumps the comment's
  # `updated_at`: that new instant becomes the fleet's last write, so this very
  # activity does not re-dispatch on the next sweep.
  jq -n --arg body "$MARK_PREFIX$n:$at -->

$FOOTER" '{body: $body}' > "$tmp"
  if [ -n "$cid" ]; then
    gh api "repos/$REPO/issues/comments/$cid" -X PATCH --input "$tmp" >/dev/null 2>&1 \
      || echo "::warning::could not update the triage-bridge marker on #$n."
  else
    gh api "repos/$REPO/issues/$n/comments" -X POST --input "$tmp" >/dev/null 2>&1 \
      || echo "::warning::could not record the triage-bridge marker on #$n."
  fi
  rm -f "$tmp"
}

# Drop the sweep marker: the issue is closed or `ready`, so it is out of scope
# and a stale marker must not linger to mislead a later reader.
remove_sweep_marker() { # remove_sweep_marker <number>
  cid=$(gh api --paginate "repos/$REPO/issues/$1/comments?per_page=100" \
    --jq "[.[] | select(.body | startswith(\"$MARK_PREFIX\"))] | last | .id // \"\"" 2>/dev/null || echo "")
  if [ -n "$cid" ]; then
    gh api "repos/$REPO/issues/comments/$cid" -X DELETE >/dev/null 2>&1 \
      || echo "::warning::could not remove the triage-bridge marker on #$1."
  fi
}

# The fleet's last write about triage: the newest `updated_at` among the owner's
# `sdlc:triase` comments and this bridge's markers (both are edited in place, so
# `updated_at` — not `created_at` — is the last-write instant). "" when the fleet
# has never written a triage comment; a body-only summary predates this bridge and
# does not count, so such an issue is dispatched once as a migration.
last_fleet_comment() { # last_fleet_comment <number>
  gh api --paginate "repos/$REPO/issues/$1/comments?per_page=100" \
    --jq '[.[] | select(.body | test("sdlc:triase|triage-bridge")) | .updated_at] | max // ""' \
    2>/dev/null || echo ""
}

# --stdin: a bot applied a type or priority label.
on_label() { # on_label <event-json>
  event="$1"
  action=$(printf '%s' "$event" | jq -r '.action // empty')
  [ "$action" = labeled ] || { echo "action='$action'; nothing to do."; exit 0; }
  label=$(printf '%s' "$event" | jq -r '.label.name // empty')
  sender=$(printf '%s' "$event" | jq -r '.sender.login // empty')
  number=$(printf '%s' "$event" | jq -r '.issue.number // .pull_request.number // empty')

  # Only a bot's label is another automation responding; a person's label is not
  # a reason to triage (and `label-guard` revokes a person's protected label).
  case "$sender" in
    *bot | *\[bot\]) : ;;
    *) echo "sender '$sender' is not a bot; nothing to do."; exit 0 ;;
  esac
  # Only a type or priority label means the labeler responded.
  is_signal=0
  case " $TYPE_LABELS " in *" $label "*) is_signal=1 ;; esac
  case "$label" in priority:*) is_signal=1 ;; esac
  [ "$is_signal" = 1 ] || { echo "label '$label' is not a type or priority; nothing to do."; exit 0; }
  [ -n "$number" ] || { echo "no issue number in the event; nothing to do."; exit 0; }

  marker=$(state_marker "$number")
  if has_comment "$number" "$marker"; then
    # The same type+priority state was already dispatched. Collapse only a burst:
    # once BURST_WINDOW has passed, a return to a state the issue held before is a
    # fresh response and dispatches again (the reviewer's "old label state holds a
    # new triage").
    age=$(state_marker_age "$number" "$marker")
    if [ -n "$age" ]; then
      since=$(( $(date -u +%s) - $(epoch "$age") ))
      if [ "$since" -lt "$BURST_WINDOW" ]; then
        echo "#$number already dispatched for this state ${since}s ago; burst collapsed."
        exit 0
      fi
    fi
  fi
  # Record the marker only after the dispatch is accepted, so a failed dispatch
  # is retried instead of being masked as done.
  if dispatch "$number" labeled "$marker"; then
    post_marker "$number" "$marker"
  else
    echo "::warning::#${number}'s label state stays unmarked; a later label or the sweep retries."
    exit 1
  fi
}

# One candidate issue: decide whether it needs a dispatch. Returns 0 when a
# dispatch was accepted, 2 when a dispatch was attempted and failed, 1 otherwise.
process_one() { # process_one <number> <updated-at>
  n="$1"; updated="$2"

  # A closed or `ready` issue is out of scope; drop any stale marker and stop.
  state=$(gh api "repos/$REPO/issues/$n" \
    --jq '[.state, (.labels[].name)] | join(" ")' 2>/dev/null || echo "")
  case " $state " in
    *" closed "* | *" ready "*)
      remove_sweep_marker "$n"
      return 1
      ;;
  esac

  last=$(last_fleet_comment "$n")
  if [ -n "$last" ]; then
    ref=$(epoch "$last")
    upd=$(epoch "$updated")
    # Strictly newer: the fleet's own write equals `updated_at`, a reporter's
    # later edit is newer. No margin, so an edit seconds after a triage counts.
    if [ "$upd" -le "$ref" ]; then
      return 1
    fi
  fi
  # Either the fleet has never written a triage comment, or the issue moved after
  # its last one. Dispatch; only a 2xx earns the marker, so a failure retries.
  if dispatch "$n" sweep-activity "$n"; then
    write_sweep_marker "$n" "$n"
    return 0
  fi
  echo "::warning::dispatch failed for #$n; the next sweep retries."
  return 2
}

# --sweep: an open, not-`ready` issue whose activity is newer than the fleet's
# last write. Catches an edited description or a new comment with no event hook.
sweep() {
  count=0
  fails=0
  # Read every page (the search returns one page otherwise), then order by the
  # most recent activity so the freshest issues are dispatched first.
  cand=$(mktemp)
  gh api --paginate -X GET search/issues \
    -f q="repo:$REPO is:issue is:open -label:ready" -f per_page=100 \
    -f sort=updated -f order=desc \
    --jq '.items[] | "\(.updated_at) \(.number)"' 2>/dev/null \
    | sort -r | head -n "$((SWEEP_PAGES * 100))" > "$cand" || true

  while read -r ts n; do
    [ -n "${n:-}" ] || continue
    [ "$count" -lt "$SWEEP_MAX" ] || { echo "Reached SWEEP_MAX=$SWEEP_MAX; the rest wait for the next run."; break; }
    process_one "$n" "$ts"
    case $? in
      0) count=$((count + 1)) ;;
      2) fails=$((fails + 1)) ;;
    esac
  done < "$cand"
  rm -f "$cand"

  echo "sweep done"
  # A failed dispatch must fail the run so it is visible and retried, not left
  # looking like a quiet, completed sweep.
  if [ "$fails" -ne 0 ]; then
    echo "::error::$fails triage dispatch(es) failed; the next sweep retries them."
    exit 1
  fi
}

case "${1:-}" in
  --stdin) on_label "$(cat)" ;;
  --sweep) sweep ;;
  *) echo "usage: issue-triage-bridge.sh --stdin | --sweep" >&2; exit 2 ;;
esac
