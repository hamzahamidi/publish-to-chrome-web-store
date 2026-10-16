import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { type MockStore, startMockStore } from './helpers.ts';

const SCRIPT = resolve(import.meta.dirname, '../scripts/publish-release.ts');
const REPO = '/repos/owner/action';
const SHA = 'c0ffee'.padEnd(40, '0');
const OTHER_SHA = 'badbad'.padEnd(40, '0');
const ISSUES = `${REPO}/issues?state=closed&labels=autorelease%3A%20pending&per_page=100&page=1`;
const FILES = ['.release-please-manifest.json', 'CHANGELOG.md', 'version.txt'];
const JOBS = [
  ['Tests (ubuntu-latest)', 'Tests (windows-latest)', 'Tests (macos-latest)', 'Action against a mock store', "Signing matches Chrome's packer", 'Sign and upload a CRX against a mock store'],
  ['Analyze (actions)', 'Analyze (javascript-typescript)'],
];
let github: MockStore;

before(async () => { github = await startMockStore(); });
afterEach(() => github.reset());
after(() => github.close());

async function run(): Promise<{ code: number | null; stdout: string; output: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'publish-release-'));
  const output = join(directory, 'output');
  try {
    const result = await new Promise<{ code: number | null; stdout: string }>((done) => {
      const child = spawn(process.execPath, [SCRIPT], {
        env: { PATH: process.env.PATH ?? '', GITHUB_API_URL: github.base, GITHUB_REPOSITORY: 'owner/action', GITHUB_TOKEN: 'gh-token', GITHUB_OUTPUT: output },
      });
      let stdout = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stdout += chunk; });
      child.on('close', (code) => done({ code, stdout }));
    });
    return { ...result, output: await readFile(output, 'utf8').catch(() => '') };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const release = (extra: Record<string, unknown> = {}) => ({ tag_name: 'v1.2.3', name: 'v1.2.3', draft: false, prerelease: false, immutable: true, ...extra });
const pr = (extra: Record<string, unknown> = {}) => ({ number: 23, merged: true, merge_commit_sha: SHA, user: { login: 'github-actions[bot]' }, merged_by: { type: 'User' }, base: { ref: 'main' }, head: { ref: 'release-please--branches--main', repo: { full_name: 'owner/action' } }, ...extra });
const ref = (sha = SHA, type = 'commit') => ({ object: { sha, type } });
const writes = () => github.requests.filter((request) => !request.key.startsWith('GET'));

function file(path: string, text: string) {
  github.on(`GET ${REPO}/contents/${path}?ref=${SHA}`, { body: { encoding: 'base64', content: Buffer.from(text).toString('base64') } });
}

function setup({ existing = false }: { existing?: boolean } = {}) {
  github.on(`GET ${ISSUES}`, { body: [{ number: 23, pull_request: {} }] });
  github.on(`GET ${REPO}/pulls/23`, { body: pr() });
  github.on(`GET ${REPO}/pulls/23/files?per_page=100&page=1`, { body: FILES.map((filename) => ({ filename })) });
  github.on(`GET ${REPO}/compare/${SHA}...main`, { body: { status: 'ahead' } });
  for (const [index, workflow] of ['ci.yml', 'codeql.yml'].entries()) {
    github.on(`GET ${REPO}/actions/workflows/${workflow}/runs?event=push&branch=main&head_sha=${SHA}&per_page=1`, { body: { workflow_runs: [workflowRun(index, workflow)] } });
    github.on(`GET ${REPO}/actions/runs/${index + 1}/jobs?filter=latest&per_page=100&page=1`, { body: { jobs: JOBS[index]!.map((name) => ({ name, status: 'completed', conclusion: 'success' })) } });
  }
  file('version.txt', '1.2.3\n');
  file('.release-please-manifest.json', '{".":"1.2.3"}');
  file('CHANGELOG.md', '# Changelog\n\n## [1.2.3](https://example.com/compare) (2026-10-16)\n\n### Bug Fixes\n\n* Refuses an invalid package.\n\n## 1.2.2\n\nOlder notes.\n');
  github.on(`GET ${REPO}/releases?per_page=100&page=1`, { body: [release({ tag_name: 'v1.2.2' })] });
  github.on(`GET ${REPO}/git/ref/tags/v1.2.3`, ...(existing ? [{ body: ref() }] : [{ status: 404, body: {} }, { body: ref() }]));
  github.on(`GET ${REPO}/releases/tags/v1.2.3`, ...(existing ? [{ body: release() }] : [{ status: 404, body: {} }, { body: release() }]));
  github.on(`POST ${REPO}/releases`, { status: 201, body: release() });
}

function workflowRun(index: number, workflow: string, extra: Record<string, unknown> = {}) {
  return { id: index + 1, head_sha: SHA, head_branch: 'main', head_repository: { full_name: 'owner/action' }, event: 'push', path: `.github/workflows/${workflow}`, status: 'completed', conclusion: 'success', ...extra };
}

describe('publish-release', () => {
  it('publishes the reviewed commit even when main advances, with exact title and reviewed notes', async () => {
    setup();
    const result = await run();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.output, 'tag=v1.2.3\npr=23\n');
    assert.equal(writes().length, 1);
    const body = JSON.parse(writes()[0]!.body);
    assert.deepEqual({ ...body, body: undefined }, { tag_name: 'v1.2.3', target_commitish: SHA, name: 'v1.2.3', draft: false, prerelease: false, body: undefined });
    assert.match(body.body, /Refuses an invalid package\./);
    assert.match(body.body, /https:\/\/github.com\/owner\/action\/pull\/23/);
    assert.match(body.body, new RegExp(SHA));
    assert.doesNotMatch(body.body, /Older notes/);
    assert.ok(github.requests.every((request) => request.auth === 'Bearer gh-token'));
  });

  it('reuses an immutable release at the same commit when alias maintenance is retried', async () => {
    setup({ existing: true });
    const result = await run();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.output, 'tag=v1.2.3\npr=23\n');
    assert.deepEqual(writes(), []);
  });

  it('does nothing without a merged pending release PR', async () => {
    github.on(`GET ${ISSUES}`, { body: [{ number: 7 }, { number: 23, pull_request: {} }] });
    github.on(`GET ${REPO}/pulls/23`, { body: pr({ merged: false }) });
    const result = await run();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.output, '');
    assert.deepEqual(writes(), []);
  });

  for (const [name, extra] of Object.entries({
    'another commit': { head_sha: OTHER_SHA },
    'a pull request run': { event: 'pull_request' },
    'another repository': { head_repository: { full_name: 'attacker/action' } },
    'another workflow': { path: '.github/workflows/other.yml' },
    'a failed run': { conclusion: 'failure' },
    'a queued run': { status: 'queued', conclusion: null },
    'another branch': { head_branch: 'feature' },
  })) {
    it(`does not publish using ${name}`, async () => {
      setup();
      github.on(`GET ${REPO}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${SHA}&per_page=1`, { body: { workflow_runs: [workflowRun(0, 'ci.yml', extra)] } });
      const result = await run();
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.output, '');
      assert.deepEqual(writes(), []);
    });
  }

  it('waits for CodeQL after CI succeeds', async () => {
    setup();
    github.on(`GET ${REPO}/actions/workflows/codeql.yml/runs?event=push&branch=main&head_sha=${SHA}&per_page=1`, { body: { workflow_runs: [] } });
    const result = await run();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.output, '');
    assert.deepEqual(writes(), []);
  });

  it('accepts successful required jobs while their reusable release caller is running', async () => {
    setup();
    github.on(`GET ${REPO}/actions/workflows/ci.yml/runs?event=push&branch=main&head_sha=${SHA}&per_page=1`, { body: { workflow_runs: [workflowRun(0, 'ci.yml', { status: 'in_progress', conclusion: null })] } });
    const result = await run();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.output, 'tag=v1.2.3\npr=23\n');
    assert.equal(writes().length, 1);
  });

  it('waits while the other workflow still has unfinished required jobs', async () => {
    setup();
    github.on(`GET ${REPO}/actions/workflows/codeql.yml/runs?event=push&branch=main&head_sha=${SHA}&per_page=1`, { body: { workflow_runs: [workflowRun(1, 'codeql.yml', { status: 'in_progress', conclusion: null })] } });
    github.on(`GET ${REPO}/actions/runs/2/jobs?filter=latest&per_page=100&page=1`, { body: { jobs: JOBS[1]!.map((name) => ({ name, status: 'in_progress', conclusion: null })) } });
    const result = await run();
    assert.equal(result.code, 0, result.stdout);
    assert.equal(result.output, '');
    assert.deepEqual(writes(), []);
  });

  for (const conclusion of ['skipped', 'failure']) {
    it(`refuses a ${conclusion} required job despite a successful workflow conclusion`, async () => {
      setup();
      github.on(`GET ${REPO}/actions/runs/1/jobs?filter=latest&per_page=100&page=1`, { body: { jobs: JOBS[0]!.map((name) => ({ name, status: 'completed', conclusion })) } });
      const result = await run();
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.output, '');
      assert.deepEqual(writes(), []);
    });
  }

  for (const [name, extra] of Object.entries({
    'a human-created PR': { user: { login: 'maintainer' } },
    'a fork PR': { head: { ref: 'release-please--branches--main', repo: { full_name: 'attacker/action' } } },
    'a deleted fork': { head: { ref: 'release-please--branches--main', repo: null } },
    'another branch': { head: { ref: 'feature', repo: { full_name: 'owner/action' } } },
    'an automated merge': { merged_by: { type: 'Bot' } },
  })) {
    it(`rejects ${name} with a pending release label`, async () => {
      setup();
      github.on(`GET ${REPO}/pulls/23`, { body: pr(extra) });
      const result = await run();
      assert.equal(result.code, 1, result.stdout);
      assert.deepEqual(writes(), []);
    });
  }

  it('rejects multiple merged pending release PRs', async () => {
    setup();
    github.on(`GET ${ISSUES}`, { body: [{ number: 23, pull_request: {} }, { number: 24, pull_request: {} }] });
    github.on(`GET ${REPO}/pulls/24`, { body: pr({ number: 24 }) });
    assert.equal((await run()).code, 1);
    assert.deepEqual(writes(), []);
  });

  it('rejects release PRs containing source or workflow changes', async () => {
    setup();
    github.on(`GET ${REPO}/pulls/23/files?per_page=100&page=1`, { body: [...FILES, 'src/main.ts'].map((filename) => ({ filename })) });
    assert.equal((await run()).code, 1);
    assert.deepEqual(writes(), []);
  });

  it('rejects a commit outside main', async () => {
    setup();
    github.on(`GET ${REPO}/compare/${SHA}...main`, { body: { status: 'diverged' } });
    assert.equal((await run()).code, 1);
    assert.deepEqual(writes(), []);
  });

  for (const version of ['1.2.4', '01.2.3', '1.2.3-rc.1', '1.2.3\npr=9']) {
    it(`rejects mismatched or noncanonical version ${JSON.stringify(version)}`, async () => {
      setup();
      file('version.txt', version);
      assert.equal((await run()).code, 1);
      assert.deepEqual(writes(), []);
    });
  }

  it('rejects release notes for a different version', async () => {
    setup();
    file('CHANGELOG.md', '# Changelog\n\n## 1.2.2\n\nOlder notes.\n');
    assert.equal((await run()).code, 1);
    assert.deepEqual(writes(), []);
  });

  it('refuses publication behind a newer stable release', async () => {
    setup();
    github.on(`GET ${REPO}/releases?per_page=100&page=1`, { body: [release({ tag_name: 'v1.10.0' })] });
    assert.equal((await run()).code, 1);
    assert.deepEqual(writes(), []);
  });

  it('does not move or recreate an existing exact tag at another commit', async () => {
    setup();
    github.on(`GET ${REPO}/git/ref/tags/v1.2.3`, { body: ref(OTHER_SHA) });
    assert.equal((await run()).code, 1);
    assert.deepEqual(writes(), []);
  });

  for (const extra of [{ immutable: false }, { draft: true }, { prerelease: true }, { name: 'Another title' }]) {
    it(`does not advance the alias or labels for an existing release with ${JSON.stringify(extra)}`, async () => {
      setup({ existing: true });
      github.on(`GET ${REPO}/releases/tags/v1.2.3`, { body: release(extra) });
      const result = await run();
      assert.equal(result.code, 1, result.stdout);
      assert.equal(result.output, '');
      assert.deepEqual(writes(), []);
    });
  }

  it('does not authorize an alias update when immutable publication is not confirmed', async () => {
    setup();
    github.on(`GET ${REPO}/releases/tags/v1.2.3`, { status: 404, body: {} }, { body: release({ immutable: false }) });
    const result = await run();
    assert.equal(result.code, 1, result.stdout);
    assert.equal(writes().length, 1);
    assert.equal(result.output, '');
  });

  it('fails closed on a GitHub API error', async () => {
    github.on(`GET ${ISSUES}`, { status: 403, body: {} });
    const result = await run();
    assert.equal(result.code, 1);
    assert.match(result.stdout, /HTTP 403/);
    assert.deepEqual(writes(), []);
  });
});
