#!/bin/sh
# Dispatch the issue triage owner when another automation has responded, or when
# a not-yet-`ready` issue has new activity.
#
# Why this exists: nothing in the fleet fires on `issues.edited`, so a reporter
# who edits an issue description gets no re-triage (found on #818, whose body was
# edited twice after triage with no answer). The triage owner is instead
# dispatched deterministically by this bridge:
#
#   --stdin   a bot applies a type or priority label — the labeler responded, so
#             the triage owner studies the issue and the bot's comment
#   --sweep   a not-`ready` issue has activity newer than its last triage — this
#             catches an edited description or a new comment without a trigger
#             on `issues.edited`
#
# One dispatch per state. The labeler applies several labels (type, priority,
# status) in one go, so the burst of `labeled` events is collapsed: the bridge
# records a marker comment keyed on the issue's type+priority set, and a later
# change of type or priority dispatches again. The sweep keys its marker on the
# issue's `updated_at`, so each distinct activity dispatches once.
#
# The triage owner is idempotent (one comment per round, updated in place), so a
# duplicate dispatch is not a duplicate comment — the markers exist to save runs.
#
# Usage: issue-triage-bridge.sh --stdin
#        issue-triage-bridge.sh --sweep
# Env:   GH_TOKEN, REPO, OPENHANDS_API_KEY, SDLC_TRIAGE_ID (default `SDLC 01`),
#        CURL (default curl), SWEEP_MAX (default 15)
set -eu

REPO="${REPO:?REPO is required}"
# `SDLC 01 · Triase bug`. Overridable so a redeploy that moves the id does not
# need a workflow edit.
TRIAGE_ID="${SDLC_TRIAGE_ID:-d648595e-b0d9-4120-bbc4-07395cdbe6bf}"
API="https://app.all-hands.dev/api/automation/v1"
CURL="${CURL:-curl}"
TYPE_LABELS="bug enhancement documentation refactor chore security"
SWEEP_MAX="${SWEEP_MAX:-15}"
# Every marker comment carries the AI-disclosure footer: without it a
# comment-triggered automation (Penjernih issue on `needs-info`, or
# acknowledge.yml) would read the marker as a reporter's reply and fire.
FOOTER="_This comment was created by an AI agent (OpenHands) on behalf of the repository maintainers._"

# Dispatch the triage owner for one issue. The body is built with jq so an issue
# number or a marker can never break out of its JSON string.
dispatch() { # dispatch <number> <reason> <key>
  n="$1"; reason="$2"; key="$3"
  if [ -z "${OPENHANDS_API_KEY:-}" ]; then
    echo "::warning::OPENHANDS_API_KEY is not set; the triage owner cannot be dispatched for #$n."
    return 0
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
  # Nothing retries a failed dispatch: a silent triage is the failure this
  # bridge exists to prevent, so the broken bridge itself must be visible.
  case "$code" in
    2??) echo "Dispatched the triage owner for #$n ($reason, HTTP $code)." ;;
    *) echo "::error::Dispatching the triage owner for #$n failed (HTTP $code)."; return 1 ;;
  esac
}

# The marker for the issue's current type+priority state. Keyed on the labels so
# the labeler's burst collapses to one dispatch while a real change re-dispatches.
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
    echo "#$number already dispatched for this type+priority state; nothing to do."
    exit 0
  fi
  post_marker "$number" "$marker"
  dispatch "$number" labeled "$marker"
}

# --sweep: a not-`ready` issue whose activity is newer than its last triage.
# Catches an edited description or a new comment with no event to hook.
sweep() {
  count=0
  gh api -X GET search/issues \
    -f q="repo:$REPO is:issue is:open -label:ready" -f per_page=50 \
    --jq '.items[].number' 2>/dev/null | while read -r n; do
    [ -n "$n" ] || continue
    [ "$count" -lt "$SWEEP_MAX" ] || { echo "Reached SWEEP_MAX=$SWEEP_MAX; the rest wait for the next run."; break; }

    updated=$(gh api "repos/$REPO/issues/$n" --jq '.updated_at' 2>/dev/null || echo "")
    [ -n "$updated" ] || continue
    # The last thing the fleet wrote about triage: the owner's `<!-- sdlc:triase -->`
    # marker (body or comment) or this bridge's own sweep marker. A minute of
    # margin keeps the marker's own write (which moves `updated_at`) from looking
    # like fresh activity.
    last=$(gh api --paginate "repos/$REPO/issues/$n/comments?per_page=100" \
      --jq '[.[] | select(.body | test("sdlc:triase|triage-bridge"))] | last | .created_at // ""' \
      2>/dev/null || echo "")
    body_marked=$(gh api "repos/$REPO/issues/$n" \
      --jq 'if (.body // "") | test("sdlc:triase") then "yes" else "no" end' 2>/dev/null || echo "no")

    # Never triaged: the body has no summary and there is no marker comment.
    if [ -z "$last" ] && [ "$body_marked" != yes ]; then
      marker="<!-- triage-bridge-sweep:$n:$updated -->"
      has_comment "$n" "$marker" && continue
      post_marker "$n" "$marker"
      dispatch "$n" sweep-new "$marker" || true
      count=$((count + 1))
      continue
    fi

    # Activity after the last triage: the description was edited or a comment
    # landed. `updated_at` moves for a label change too, which is also a bot
    # response the owner should read.
    [ -n "$last" ] || continue
    ref_epoch=$(date -u -d "$last" +%s 2>/dev/null || echo 0)
    upd_epoch=$(date -u -d "$updated" +%s 2>/dev/null || echo 0)
    if [ "$upd_epoch" -gt $((ref_epoch + 60)) ]; then
      marker="<!-- triage-bridge-sweep:$n:$updated -->"
      has_comment "$n" "$marker" && continue
      post_marker "$n" "$marker"
      dispatch "$n" sweep-activity "$marker" || true
      count=$((count + 1))
    fi
  done
  echo "sweep done"
}

case "${1:-}" in
  --stdin) on_label "$(cat)" ;;
  --sweep) sweep ;;
  *) echo "usage: issue-triage-bridge.sh --stdin | --sweep" >&2; exit 2 ;;
esac
