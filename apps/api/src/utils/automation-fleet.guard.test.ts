import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

/**
 * The fleet's new deterministic consequences, driven against a stub `gh`:
 *
 *  - `label-guard.sh` removes a protected label applied by anyone but
 *    `cipansor-bot`, leaves the bot's and a GitHub App's labels, leaves the
 *    human-decision labels, and tells the actor once;
 *  - `reaction.sh` adds exactly one acknowledgement reaction, replacing any the
 *    same account left before;
 *  - `basmalah.sh` puts the basmalah at the top of a description and is
 *    idempotent.
 *
 * Plus the contracts the prompts and workflows share: the basmalah is in both
 * issue forms and the PR template, and the two scripts are wired into the
 * workflows that run them.
 */
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const LABEL_GUARD = join(REPO_ROOT, '.github', 'scripts', 'label-guard.sh');
const REACTION = join(REPO_ROOT, '.github', 'scripts', 'reaction.sh');
const BASMALAH = join(REPO_ROOT, '.github', 'scripts', 'basmalah.sh');
const WORKFLOWS = join(REPO_ROOT, '.github', 'workflows');

const AI_FOOTER = 'This comment was created by an AI agent';

const STUB = `#!/bin/sh
log() { [ -n "\${GH_STUB_LOG:-}" ] && echo "$*" >> "$GH_STUB_LOG"; }
case "$1" in
  label)
    case "$2" in
      list) printf '%s\\n' "\${GH_STUB_LABELS:-}" ;;
    esac ;;
  api)
    case "$*" in
      *"/collaborators/"*"/permission"*) printf '%s\\n' "\${GH_STUB_PERM:-none}" ;;
      *"/comments?per_page"*) [ -n "\${GH_STUB_COMMENTS:-}" ] && printf '%s\\n' "\${GH_STUB_COMMENTS}" ;;
      *"/reactions?per_page"*) [ -n "\${GH_STUB_REACTIONS:-}" ] && printf '%s\\n' "\${GH_STUB_REACTIONS}" ;;
      *"/issues/"*"/labels"*"--jq"*) [ -n "\${GH_STUB_CURRENT:-}" ] && printf '%s\\n' "\${GH_STUB_CURRENT}" ;;
      *"/issues/comments/"*"/reactions"*"-f content"*) log "REACT_COMMENT $*" ;;
      *"/issues/"*"/reactions"*"-f content"*) log "REACT_ISSUE $*" ;;
      *"/issues/"*"/comments"*"-f body"*) log "COMMENT $*" ;;
      *"-X DELETE"*"/labels/"*) log "UNLABEL $*" ;;
      *"-X DELETE"*"/reactions/"*) log "UNREACT $*" ;;
      *"--jq .body"*) printf '%s\\n' "\${GH_STUB_BODY:-}" ;;
      *"-X PATCH"*) log "PATCH $*" ;;
      *"/user"*) printf '%s\\n' "\${GH_STUB_LOGIN:-cipansor-bot}" ;;
    esac ;;
esac
exit 0
`;

let dir: string;
let log: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-guards-'));
  writeFileSync(join(dir, 'gh'), STUB, { mode: 0o755 });
  log = join(dir, 'calls.log');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string, env: Record<string, string>, args: string[] = [], stdin?: string) {
  writeFileSync(log, '');
  const r = spawnSync('sh', [script, ...args], {
    encoding: 'utf8',
    input: stdin,
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      REPO: 'o/r',
      GH_TOKEN: 'x',
      GH_STUB_LOG: log,
      ...env,
    },
  });
  return {
    status: r.status ?? -1,
    out: `${r.stdout}${r.stderr}`,
    calls: existsSync(log) ? readFileSync(log, 'utf8') : '',
  };
}

const LABELS =
  'bug\nenhancement\nready\npriority:medium\nrilis-disetujui\nrilis-ditolak\nbot-implement';

const labeledEvent = (login: string, label: string, opts: { pr?: boolean } = {}) =>
  JSON.stringify({
    action: 'labeled',
    sender: { login },
    label: { name: label },
    ...(opts.pr ? { pull_request: { number: 7 } } : { issue: { number: 7, pull_request: null } }),
  });

describe('label-guard.sh', () => {
  it('removes a protected label applied by a person and says so once', () => {
    const { calls, out } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS, GH_STUB_PERM: 'triage' },
      ['--stdin'],
      labeledEvent('someone', 'ready')
    );
    expect(calls).toContain('UNLABEL');
    expect(calls).toContain('/issues/7/labels/ready');
    expect(calls).toContain('COMMENT');
    expect(out).toContain('Removed label');
  });

  it('leaves a label the bot applied', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS },
      ['--stdin'],
      labeledEvent('cipansor-bot', 'ready')
    );
    expect(calls).not.toContain('UNLABEL');
    expect(calls).not.toContain('COMMENT');
  });

  it('leaves a label a GitHub App applied', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS },
      ['--stdin'],
      labeledEvent('github-actions[bot]', 'ready')
    );
    expect(calls).not.toContain('UNLABEL');
  });

  it('leaves the human-decision labels even when a person applies them', () => {
    for (const label of ['rilis-disetujui', 'rilis-ditolak', 'bot-implement']) {
      const { calls } = run(
        LABEL_GUARD,
        { GH_STUB_LABELS: LABELS, GH_STUB_PERM: 'admin' },
        ['--stdin'],
        labeledEvent('adminypc', label)
      );
      expect(calls, label).not.toContain('UNLABEL');
    }
  });

  it('leaves a label that is not in the repository', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS },
      ['--stdin'],
      labeledEvent('someone', 'made-up-label')
    );
    expect(calls).not.toContain('UNLABEL');
  });

  it('works on a pull request, whose number is its issue number', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS },
      ['--stdin'],
      labeledEvent('someone', 'bug', { pr: true })
    );
    expect(calls).toContain('/issues/7/labels/bug');
  });

  it('does not stack a second notice', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS, GH_STUB_COMMENTS: `Label dicabut <!-- label-guard:revoked -->` },
      ['--stdin'],
      labeledEvent('someone', 'ready')
    );
    expect(calls).toContain('UNLABEL');
    expect(calls).not.toContain('COMMENT');
  });

  it('does nothing when the label is removed, not added', () => {
    const ev = JSON.stringify({
      action: 'unlabeled',
      sender: { login: 'someone' },
      label: { name: 'ready' },
      issue: { number: 7 },
    });
    const { calls } = run(LABEL_GUARD, { GH_STUB_LABELS: LABELS }, ['--stdin'], ev);
    expect(calls).not.toContain('UNLABEL');
  });

  it('removes a `ready` that contradicts an open question, even from the bot', () => {
    const { calls, out } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS, GH_STUB_CURRENT: 'ready\nquestion\nbug' },
      ['--stdin'],
      labeledEvent('cipansor-bot', 'ready')
    );
    expect(calls).toContain('/issues/7/labels/ready');
    expect(calls).toContain('COMMENT');
    expect(out).toContain("contradicts 'question'");
  });

  it('removes a `ready` that contradicts `needs-info`', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS, GH_STUB_CURRENT: 'ready\nneeds-info' },
      ['--stdin'],
      labeledEvent('cipansor-bot', 'ready')
    );
    expect(calls).toContain('/issues/7/labels/ready');
  });

  it('leaves `ready` alone when nothing contradicts it', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS, GH_STUB_CURRENT: 'ready\nbug\npriority:high' },
      ['--stdin'],
      labeledEvent('cipansor-bot', 'ready')
    );
    expect(calls).not.toContain('UNLABEL');
  });
});

describe('reaction.sh', () => {
  it('reacts eyes on the issue and replaces the earlier reaction', () => {
    const { calls } = run(
      REACTION,
      { GH_STUB_LOGIN: 'cipansor-bot', GH_STUB_REACTIONS: '123 eyes' },
      ['7']
    );
    expect(calls).toContain('UNREACT');
    expect(calls).toContain('/reactions/123');
    expect(calls).toContain('REACT_ISSUE');
  });

  it('reacts on a comment when given its id', () => {
    const { calls } = run(REACTION, { GH_STUB_LOGIN: 'cipansor-bot' }, ['7', '555']);
    expect(calls).toContain('REACT_COMMENT');
    expect(calls).toContain('/issues/comments/555/reactions');
  });
});

describe('basmalah.sh', () => {
  const ARABIC = 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ';

  it('prepends the basmalah when the description does not open with it', () => {
    const ev = JSON.stringify({ action: 'opened', issue: { number: 7 } });
    const { calls } = run(BASMALAH, { GH_STUB_BODY: 'A plain report' }, ['--stdin'], ev);
    expect(calls).toContain('PATCH');
  });

  it('is idempotent when the description already opens with the basmalah', () => {
    const ev = JSON.stringify({ action: 'opened', issue: { number: 7 } });
    const { calls } = run(
      BASMALAH,
      { GH_STUB_BODY: `${ARABIC}\n\nA plain report` },
      ['--stdin'],
      ev
    );
    expect(calls).not.toContain('PATCH');
  });

  it('does nothing on a non-open event', () => {
    const ev = JSON.stringify({ action: 'labeled', issue: { number: 7 } });
    const { calls } = run(BASMALAH, { GH_STUB_BODY: 'x' }, ['--stdin'], ev);
    expect(calls).not.toContain('PATCH');
  });

  it('reads the number from a pull_request_target payload too', () => {
    const ev = JSON.stringify({ action: 'opened', pull_request: { number: 7 } });
    const { calls } = run(BASMALAH, { GH_STUB_BODY: 'A plain description' }, ['--stdin'], ev);
    expect(calls).toContain('/issues/7');
    expect(calls).toContain('PATCH');
  });
});

describe('fleet contracts', () => {
  const read = (p: string) => readFileSync(p, 'utf8');

  it('opens every issue form and the PR template with the basmalah', () => {
    const arabic = 'بِسْمِ اللَّهِ الرَّحْمَنِ الرَّحِيمِ';
    for (const file of ['bug_report.yml', 'feature_request.yml']) {
      expect(read(join(REPO_ROOT, '.github', 'ISSUE_TEMPLATE', file)), file).toContain(arabic);
    }
    expect(read(join(REPO_ROOT, '.github', 'pull_request_template.md'))).toContain(arabic);
  });

  it('wires the label guard, acknowledgement and basmalah into workflows', () => {
    expect(read(join(WORKFLOWS, 'label-guard.yml'))).toContain('label-guard.sh');
    expect(read(join(WORKFLOWS, 'acknowledge.yml'))).toContain('reaction.sh');
    expect(read(join(WORKFLOWS, 'basmalah.yml'))).toContain('basmalah.sh');
  });

  it('has the label guard read the whole event, not a truncated one', () => {
    expect(read(join(WORKFLOWS, 'label-guard.yml'))).toContain('"$GITHUB_EVENT_PATH"');
  });

  it('keeps the AI-disclosure footer in the label-guard notice', () => {
    expect(read(LABEL_GUARD)).toContain(AI_FOOTER);
  });
});
