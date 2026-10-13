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
const ACKNOWLEDGE = join(REPO_ROOT, '.github', 'scripts', 'acknowledge.sh');
const DEPLOY = join(REPO_ROOT, 'scripts', 'deploy-sdlc-agents.py');
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
      *"--jq .body"*)
        n=$(cat "\${GH_STUB_LOG}.n" 2>/dev/null || echo 0)
        echo $((n + 1)) > "\${GH_STUB_LOG}.n"
        if [ "$n" -eq 0 ]; then printf '%s' "\${GH_STUB_BODY:-}"; else printf '%s' "\${GH_STUB_BODY2:-\${GH_STUB_BODY:-}}"; fi ;;
      *"-X PATCH"*"--input"*)
        for a in "$@"; do last="$a"; done
        log "PATCH $*"
        log "PATCH_BODY $(cat "$last" 2>/dev/null)" ;;
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
  rmSync(`${log}.n`, { force: true });
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
  'bug\nenhancement\nready\nquestion\nneeds-info\npriority:high\npriority:medium\nrilis-disetujui\nrilis-ditolak\nbot-implement';

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

  it('revokes the human-applied exclusion and keeps the legitimate `ready`', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS, GH_STUB_PERM: 'admin', GH_STUB_CURRENT: 'ready\nquestion' },
      ['--stdin'],
      labeledEvent('adminypc', 'question')
    );
    // `question` (the event label) is revoked; `ready` is left in place.
    expect(calls).toContain('/issues/7/labels/question');
    expect(calls).not.toContain('/issues/7/labels/ready');
  });

  it('removes `ready` and still revokes a human label added during the conflict', () => {
    // The reviewer's scenario: with `ready`+`question` present, a person adds
    // `priority:high`. Removing `ready` must not swallow the standard path's
    // revocation of that protected label.
    const { calls } = run(
      LABEL_GUARD,
      {
        GH_STUB_LABELS: LABELS,
        GH_STUB_PERM: 'triage',
        GH_STUB_CURRENT: 'ready\nquestion',
      },
      ['--stdin'],
      labeledEvent('someone', 'priority:high')
    );
    expect(calls).toContain('/issues/7/labels/ready');
    expect(calls).toContain('/issues/7/labels/priority:high');
  });

  it('removes `ready` when a conflict exists and the event label is unrelated', () => {
    const { calls } = run(
      LABEL_GUARD,
      { GH_STUB_LABELS: LABELS, GH_STUB_CURRENT: 'ready\nquestion' },
      ['--stdin'],
      labeledEvent('cipansor-bot', 'priority:high')
    );
    expect(calls).toContain('/issues/7/labels/ready');
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

describe('acknowledge.sh', () => {
  const event = (opts: { association?: string; labels?: string[]; body?: string; bot?: boolean }) =>
    JSON.stringify({
      action: 'created',
      comment: {
        id: 555,
        body: opts.bot
          ? 'Reply\n\n_This comment was created by an AI agent (OpenHands) on behalf of the maintainer._'
          : (opts.body ?? 'A reply'),
        author_association: opts.association ?? 'NONE',
      },
      issue: { number: 7, labels: (opts.labels ?? []).map((name) => ({ name })) },
    });

  it('acknowledges an @openhands mention', () => {
    const { calls } = run(
      ACKNOWLEDGE,
      { GH_STUB_LOGIN: 'cipansor-bot' },
      ['--stdin'],
      event({ association: 'OWNER', body: '@openhands please look' })
    );
    expect(calls).toContain('REACT_COMMENT');
  });

  it('acknowledges an outside reporter answering a `needs-info` issue', () => {
    // Penjernih issue fires on the reporter's reply, so it must be acknowledged.
    const { calls } = run(
      ACKNOWLEDGE,
      { GH_STUB_LOGIN: 'cipansor-bot' },
      ['--stdin'],
      event({ association: 'NONE', labels: ['needs-info', 'bug'] })
    );
    expect(calls).toContain('REACT_COMMENT');
  });

  it('acknowledges a maintainer on a `pending-maintainer` issue', () => {
    const { calls } = run(
      ACKNOWLEDGE,
      { GH_STUB_LOGIN: 'cipansor-bot' },
      ['--stdin'],
      event({ association: 'OWNER', labels: ['pending-maintainer'] })
    );
    expect(calls).toContain('REACT_COMMENT');
  });

  it('does not acknowledge an outsider on a `pending-maintainer` issue', () => {
    const { calls } = run(
      ACKNOWLEDGE,
      { GH_STUB_LOGIN: 'cipansor-bot' },
      ['--stdin'],
      event({ association: 'NONE', labels: ['pending-maintainer'] })
    );
    expect(calls).not.toContain('REACT_COMMENT');
  });

  it("never acknowledges the bot's own comment", () => {
    const { calls } = run(
      ACKNOWLEDGE,
      { GH_STUB_LOGIN: 'cipansor-bot' },
      ['--stdin'],
      event({ association: 'OWNER', labels: ['needs-info'], bot: true })
    );
    expect(calls).not.toContain('REACT_COMMENT');
  });

  it('does not acknowledge an ordinary comment', () => {
    const { calls } = run(
      ACKNOWLEDGE,
      { GH_STUB_LOGIN: 'cipansor-bot' },
      ['--stdin'],
      event({ association: 'OWNER', labels: ['bug'] })
    );
    expect(calls).not.toContain('REACT_COMMENT');
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

  it('prepends to the fresh body when a summary landed mid-run', () => {
    // A `<!-- sdlc:… -->` summary written between the first read and the PATCH
    // must survive: the basmalah goes onto the fresh body, not the stale one.
    const ev = JSON.stringify({ action: 'opened', issue: { number: 7 } });
    const { calls } = run(
      BASMALAH,
      {
        GH_STUB_BODY: 'A plain report',
        GH_STUB_BODY2: 'A plain report\n\n<!-- sdlc:triase -->\nsummary',
      },
      ['--stdin'],
      ev
    );
    expect(calls).toContain('PATCH');
    // The PATCH body is the fresh one (its summary is included).
    expect(calls).toContain('sdlc:triase');
  });

  it('does nothing when the fresh read already opens with the basmalah', () => {
    const ev = JSON.stringify({ action: 'opened', issue: { number: 7 } });
    const { calls } = run(
      BASMALAH,
      { GH_STUB_BODY: 'A plain report', GH_STUB_BODY2: `${ARABIC}\n\nA plain report` },
      ['--stdin'],
      ev
    );
    expect(calls).not.toContain('PATCH');
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
    expect(read(join(WORKFLOWS, 'acknowledge.yml'))).toContain('acknowledge.sh');
    expect(read(join(WORKFLOWS, 'basmalah.yml'))).toContain('basmalah.sh');
  });

  it('has the label guard read the whole event, not a truncated one', () => {
    expect(read(join(WORKFLOWS, 'label-guard.yml'))).toContain('"$GITHUB_EVENT_PATH"');
  });

  it('keeps the AI-disclosure footer in the label-guard notice', () => {
    expect(read(LABEL_GUARD)).toContain(AI_FOOTER);
  });
});

describe('deploy-sdlc-agents.py', () => {
  const hasPy = spawnSync('python3', ['--version']).status === 0;
  const FOOTER =
    '_This comment was created by an AI agent (OpenHands) on behalf of the maintainer._';

  // Call the real new_prompt(name, prompt) from the script (its __main__ is
  // guarded, so importing it does nothing else).
  const newPrompt = (name: string, prompt: string): string => {
    const driver = [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("d", sys.argv[1])',
      'm = importlib.util.module_from_spec(spec)',
      'spec.loader.exec_module(m)',
      'sys.stdout.write(m.new_prompt(sys.argv[2], sys.stdin.read()))',
    ].join('\n');
    const r = spawnSync('python3', ['-c', driver, DEPLOY, name], {
      encoding: 'utf8',
      input: prompt,
    });
    if (r.status !== 0) throw new Error(r.stderr || 'python failed');
    return r.stdout;
  };

  it.skipIf(!hasPy)('keeps the original tail when it has no replacement tail', () => {
    const original = `Header\n\n${FOOTER}\n\nPERILAKU SASARAN (level agentic)\nAturan khusus yang harus utuh`;
    const out = newPrompt('SDLC 03', original);
    // The old tail survives, the BODY block is inserted, nothing is truncated.
    expect(out).toContain('Aturan khusus yang harus utuh');
    expect(out).toContain('BODY ISSUE/PR');
    expect(out.endsWith('Aturan khusus yang harus utuh')).toBe(true);
  });

  it.skipIf(!hasPy)('is idempotent: a second pass does not duplicate the body block', () => {
    const original = `Header\n\n${FOOTER}\n\nPERILAKU SASARAN (level agentic)\nTail`;
    const once = newPrompt('SDLC 03', original);
    const twice = newPrompt('SDLC 03', once);
    expect(twice).toBe(once);
    expect(twice.split('BODY ISSUE/PR').length - 1).toBe(1);
  });

  it.skipIf(!hasPy)('uses the replacement tail for an automation that has one', () => {
    const original = `Header\n\n${FOOTER}\n\nPERILAKU SASARAN (level agentic)\nOLD tail`;
    const out = newPrompt('SDLC 01', original);
    expect(out).not.toContain('OLD tail');
    expect(out).toContain('KRITIS dan habis-habisan');
  });

  it.skipIf(!hasPy)('rebuilds from an original even when the live prompt lost its tail', () => {
    // The repair path: the truncated live prompt is not the base when the
    // original is supplied, so the tail comes back.
    const truncated = `Header\n\n${FOOTER}\n\nBODY ISSUE/PR — SATU DESKRIPSI (WAJIB)\n- x`;
    const original = `Header\n\n${FOOTER}\n\nPERILAKU SASARAN (level agentic)\nAturan khusus`;
    expect(newPrompt('SDLC 03', original)).toContain('Aturan khusus');
    // And the buggy base would not have recovered it (idempotent head only).
    expect(newPrompt('SDLC 03', truncated)).not.toContain('Aturan khusus');
  });
});
