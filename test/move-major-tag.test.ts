import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { type MockStore, startMockStore } from './helpers.ts';

const SCRIPT = resolve(import.meta.dirname, '../scripts/move-major-tag.ts');
const REPO = '/repos/owner/action';
const COMMIT = 'c0ffee'.padEnd(40, '0');
const OLD_COMMIT = 'badbad'.padEnd(40, '0');
let github: MockStore;

before(async () => {
  github = await startMockStore();
});
afterEach(() => github.reset());
after(() => github.close());

function run(tag: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: { PATH: process.env.PATH ?? '', GITHUB_API_URL: github.base, GITHUB_REPOSITORY: 'owner/action', GITHUB_TOKEN: 'gh-token', TAG: tag },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => done({ code, stdout }));
  });
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({ tag_name: tag, draft: false, prerelease: false, immutable: true, ...extra });

function setup(newestTag: string, list: object[], { v1 = OLD_COMMIT }: { v1?: string | null } = {}) {
  github.on(`GET ${REPO}/releases?per_page=100&page=1`, { body: list });
  github.on(`GET ${REPO}/git/ref/tags/${newestTag}`, { body: { object: { type: 'commit', sha: COMMIT } } });
  if (v1) github.on(`GET ${REPO}/git/ref/tags/v1`, { body: { object: { type: 'commit', sha: v1 } } });
}

const writes = () => github.requests.filter((request) => !request.key.startsWith('GET'));

describe('move-major-tag', () => {
  it('moves v1 to the newest release with the workflow token', async () => {
    setup('v1.2.0', [release('v1.2.0'), release('v1.1.0'), release('v2.0.0')]);
    github.on(`PATCH ${REPO}/git/refs/tags/v1`, { body: { ref: 'refs/tags/v1' } });
    const result = await run('v1.2.0');
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /v1 now points at v1\.2\.0 \(c0ffee000000\)\./);
    assert.deepEqual(
      writes().map((request) => [request.key, JSON.parse(request.body)]),
      [[`PATCH ${REPO}/git/refs/tags/v1`, { sha: COMMIT, force: true }]],
    );
    assert.ok(github.requests.every((request) => request.auth === 'Bearer gh-token'));
  });

  it('creates v1 when it does not exist yet', async () => {
    setup('v1.0.0', [release('v1.0.0')], { v1: null });
    github.on(`POST ${REPO}/git/refs`, { status: 201, body: {} });
    const result = await run('v1.0.0');
    assert.equal(result.code, 0, result.stdout);
    assert.deepEqual(
      writes().map((request) => [request.key, JSON.parse(request.body)]),
      [[`POST ${REPO}/git/refs`, { ref: 'refs/tags/v1', sha: COMMIT }]],
    );
  });

  it('follows an annotated tag to its commit', async () => {
    setup('v1.0.0', [release('v1.0.0')]);
    github.on(`GET ${REPO}/git/ref/tags/v1.0.0`, { body: { object: { type: 'tag', sha: 'annotated' } } });
    github.on(`GET ${REPO}/git/tags/annotated`, { body: { object: { type: 'commit', sha: COMMIT } } });
    github.on(`PATCH ${REPO}/git/refs/tags/v1`, { body: {} });
    const result = await run('v1.0.0');
    assert.equal(result.code, 0, result.stdout);
    assert.equal(JSON.parse(writes()[0]!.body).sha, COMMIT);
  });

  it('keeps v1 on the newest release, compared by number, when an older patch is released', async () => {
    setup('v1.10.0', [release('v1.9.0'), release('v1.10.0'), release('v1.0.3'), release('v1.11.0-rc.1', { prerelease: true }), release('v1.12.0', { draft: true })], { v1: COMMIT });
    const result = await run('v1.0.3');
    assert.equal(result.code, 0, result.stdout);
    assert.match(result.stdout, /v1\.0\.3 is not the newest v1 release, so v1 follows v1\.10\.0\./);
    assert.match(result.stdout, /v1 already points at v1\.10\.0/);
    assert.deepEqual(writes(), []);
  });

  it('refuses to move v1 to a release that is not immutable', async () => {
    setup('v1.0.0', [release('v1.0.0', { immutable: false })]);
    const result = await run('v1.0.0');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /::error::Release v1\.0\.0 is not immutable/);
    assert.deepEqual(writes(), []);
  });

  it('reports why GitHub refused the move', async () => {
    setup('v1.1.0', [release('v1.1.0')]);
    github.on(`PATCH ${REPO}/git/refs/tags/v1`, { status: 422, body: { message: 'Reference update failed' } });
    const result = await run('v1.1.0');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /::error::Moving v1 failed \(HTTP 422\): Reference update failed%0AIf the workflow files of v1\.1\.0 differ/);
    assert.equal(writes().length, 1);
  });

  it('stops when the current v1 cannot be read', async () => {
    setup('v1.1.0', [release('v1.1.0')], { v1: null });
    github.on(`GET ${REPO}/git/ref/tags/v1`, { status: 500, body: {} });
    const result = await run('v1.1.0');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Reading v1 failed \(HTTP 500\)/);
    assert.deepEqual(writes(), []);
  });

  it('refuses a tag that is not vMAJOR.MINOR.PATCH', async () => {
    const result = await run('v1.0');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /is not vMAJOR\.MINOR\.PATCH/);
    assert.equal(github.requests.length, 0);
  });
});
