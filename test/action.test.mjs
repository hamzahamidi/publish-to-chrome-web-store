import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { closedPort, extensionZip, FETCH, ITEM, makeZip, PUBLISH, PUBLISHER, startMockStore, storeStatus, UPLOAD } from './helpers.mjs';

const MAIN = resolve(import.meta.dirname, '../src/main.mjs');
const TOKEN = 'ya29.test-access-token';
const dir = mkdtempSync(join(tmpdir(), 'cws-action-'));
let store;

before(async () => {
  store = await startMockStore();
});
afterEach(() => store.reset());
after(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

function zipFile(version, name = `ext-${version}.zip`, content = extensionZip(version)) {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function runAction(inputs, env = {}) {
  const output = join(dir, `output-${Math.random().toString(16).slice(2)}`);
  writeFileSync(output, '');
  const inputEnv = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]));
  return new Promise((done) => {
    const child = spawn(process.execPath, [MAIN], {
      env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, CWS_API_BASE: store.base, ...inputEnv, ...env },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => done({ code, stdout, outputs: parseOutputs(readFileSync(output, 'utf8')) }));
  });
}

function parseOutputs(text) {
  const outputs = {};
  const pattern = /^([\w-]+)<<(EOF_[\w-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm;
  for (const match of text.matchAll(pattern)) outputs[match[1]] = match[3];
  return outputs;
}

const baseInputs = (version, extra = {}) => ({
  'access-token': TOKEN,
  'publisher-id': PUBLISHER,
  'item-id': ITEM,
  zip: zipFile(version),
  ...extra,
});

const withoutMaskLines = (stdout) =>
  stdout
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n');

describe('action', () => {
  it('uploads and submits, sets the outputs and never prints the token', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const run = await runAction(baseInputs('1.0.1'));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.0.1', result: 'submitted', state: 'PENDING_REVIEW' });
    assert.deepEqual(
      store.requests.map((request) => request.key),
      [FETCH, UPLOAD, PUBLISH, FETCH],
    );
    assert.ok(run.stdout.includes(`::add-mask::${TOKEN}`));
    assert.ok(!withoutMaskLines(run.stdout).includes(TOKEN));
  });

  it('reports a skipped run with the store state', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0', submitted: '1.0.1' }));
    const run = await runAction(baseInputs('1.0.1'));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.0.1', result: 'skipped', state: 'PENDING_REVIEW' });
  });

  it('uploads only when publish is false, and sends the staged type when asked', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    const uploadOnly = await runAction(baseInputs('1.0.0', { publish: 'false' }));
    assert.equal(uploadOnly.code, 0, uploadOnly.stdout);
    assert.equal(uploadOnly.outputs.result, 'uploaded');
    assert.equal(store.requests.length, 2);

    store.reset();
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const staged = await runAction(baseInputs('1.0.0', { 'publish-type': 'Staged' }));
    assert.equal(staged.code, 0, staged.stdout);
    assert.deepEqual(JSON.parse(store.requests[2].body), { publishType: 'STAGED_PUBLISH' });
  });

  it('checks the credentials and the store state on a dry run, without uploading', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    const run = await runAction(baseInputs('1.0.1', { 'dry-run': 'true' }));
    assert.equal(run.code, 0, run.stdout);
    assert.deepEqual(run.outputs, { version: '1.0.1', result: 'dry-run', state: '' });
    assert.deepEqual(
      store.requests.map((request) => request.key),
      [FETCH],
    );
  });

  it('prints store warnings as warning annotations', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'BROAD_HOST_PERMISSION', description: 'broad host permission' }] } } });
    const run = await runAction(baseInputs('1.0.0'));
    assert.equal(run.code, 0, run.stdout);
    assert.match(run.stdout, /^::warning::Chrome Web Store warning BROAD_HOST_PERMISSION: broad host permission$/m);
  });

  it('fails with an error annotation that keeps the details on separate lines', async () => {
    store.on(FETCH, storeStatus({ submitted: '1.0.0' }));
    const run = await runAction(baseInputs('1.0.1'));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /^::error::Version 1\.0\.0 is still in review\..*%0AWait for the review to finish/m);
    assert.equal(run.outputs.version, '1.0.1');
    assert.equal(run.outputs.result, undefined);
  });

  it('exchanges a refresh token, masks the new access token and uses it', async () => {
    store.on('POST /token', { body: { access_token: 'ya29.minted', expires_in: 3599, token_type: 'Bearer' } });
    store.on(FETCH, storeStatus({ published: '1.0.1' }));
    const run = await runAction(
      { 'client-id': 'client.apps.googleusercontent.com', 'client-secret': 'shh-secret', 'refresh-token': '1//refresh', 'publisher-id': PUBLISHER, 'item-id': ITEM, zip: zipFile('1.0.1') },
      { CWS_TOKEN_ENDPOINT: `${store.base}/token` },
    );
    assert.equal(run.code, 0, run.stdout);
    const form = new URLSearchParams(store.requests[0].body);
    assert.deepEqual(Object.fromEntries(form), {
      client_id: 'client.apps.googleusercontent.com',
      client_secret: 'shh-secret',
      refresh_token: '1//refresh',
      grant_type: 'refresh_token',
    });
    assert.equal(store.requests[1].auth, 'Bearer ya29.minted');
    for (const secret of ['ya29.minted', 'client.apps.googleusercontent.com', 'shh-secret', '1//refresh']) {
      assert.ok(run.stdout.includes(`::add-mask::${secret}`), `expected ${secret} to be masked`);
      assert.ok(!withoutMaskLines(run.stdout).includes(secret), `${secret} leaked`);
    }
    const lines = run.stdout.split(/\r?\n/).filter(Boolean);
    const firstPlain = lines.findIndex((line) => !line.startsWith('::'));
    const lastMask = lines.findLastIndex((line) => line.startsWith('::add-mask::'));
    assert.ok(lastMask < firstPlain, 'every mask must come before the first log line');
  });

  it('explains an expired refresh token', async () => {
    store.on('POST /token', { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' } });
    const run = await runAction(
      { 'client-id': 'id', 'client-secret': 'secret', 'refresh-token': 'refresh', 'publisher-id': PUBLISHER, 'item-id': ITEM, zip: zipFile('1.0.1') },
      { CWS_TOKEN_ENDPOINT: `${store.base}/token` },
    );
    assert.equal(run.code, 1);
    assert.match(run.stdout, /Google refused the refresh token with invalid_grant: Token has been expired or revoked\.%0ARefresh tokens of an OAuth app in Testing status expire after 7 days/);
    assert.equal(store.requests.length, 1);
  });

  const invalid = [
    ['no credentials', { 'access-token': '' }, /No credentials\./],
    ['both credential kinds', { 'refresh-token': 'x' }, /Pass either access-token or the client-id, client-secret and refresh-token trio, not both/],
    ['a partial refresh trio', { 'access-token': '', 'client-id': 'id', 'refresh-token': 'x' }, /Missing client-secret\./],
    ['a missing publisher-id', { 'publisher-id': '' }, /Input publisher-id is required\./],
    ['a publisher-id with a path', { 'publisher-id': '../items' }, /publisher-id must contain only/],
    ['an item-id that is not an extension ID', { 'item-id': 'not-an-id' }, /item-id must be the 32 letter extension ID/],
    ['an unknown publish-type', { 'publish-type': 'now' }, /publish-type must be default or staged, got "now"/],
    ['a publish value that is not boolean', { publish: 'yes' }, /Input publish must be true or false, got "yes"/],
    ['a missing ZIP', { zip: 'nope/ext.zip' }, /Cannot read "nope\/ext\.zip": no such file\./],
  ];
  for (const [label, override, pattern] of invalid) {
    it(`stops before any request on ${label}`, async () => {
      const run = await runAction(baseInputs('1.0.0', override));
      assert.equal(run.code, 1, run.stdout);
      assert.match(run.stdout, pattern);
      assert.equal(store.requests.length, 0);
    });
  }

  it('refuses a package larger than the store accepts without reading it', { skip: process.platform === 'win32' && 'sparse files' }, async () => {
    const zip = zipFile('1.0.0', 'huge.zip', Buffer.alloc(0));
    truncateSync(zip, 2 * 1024 ** 3 + 1);
    const run = await runAction(baseInputs('1.0.0', { zip }));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /is larger than 2 GB, the largest package the Chrome Web Store accepts\./);
    assert.equal(store.requests.length, 0);
  });

  it('keeps hostile store text from starting workflow commands', async () => {
    const hostile = 'bad\n::error::owned\r::add-mask::x %0A \u2028::warning::spoof ##[group]g';
    store.on(FETCH, {
      body: {
        publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: `0.9\n::error::owned` }] },
      },
    });
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'X', description: hostile }] } } });
    const warned = await runAction(baseInputs('1.0.0'));
    store.reset();
    store.on(FETCH, { status: 400, body: { error: { code: 400, message: hostile } } });
    const failed = await runAction(baseInputs('1.0.0'));
    for (const run of [warned, failed]) {
      const lines = run.stdout.split(/\r?\n/);
      assert.ok(!lines.some((line) => /^[\s\u0085\u2028]*::(error::owned|add-mask::x|warning::spoof)/.test(line)), run.stdout);
      assert.ok(!lines.some((line) => /^[\s\u0085\u2028]*##\[group\]/.test(line)), run.stdout);
    }
    assert.match(warned.stdout, /^::warning::Chrome Web Store warning X: bad%0A::error::owned%0D::add-mask::x %250A/m);
    assert.match(failed.stdout, /^::error::GET .*fetchStatus returned HTTP 400: bad%0A::error::owned/m);
  });

  it('stops before any request when the ZIP has no manifest at its root', async () => {
    const zip = zipFile('1.0.0', 'nested.zip', makeZip([{ name: 'dist/manifest.json', data: '{"version":"1.0.0"}' }]));
    const run = await runAction(baseInputs('1.0.0', { zip }));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /no manifest\.json at its root, only "dist\/manifest\.json"/);
    assert.ok(!run.stdout.includes('holds version'));
    assert.equal(store.requests.length, 0);
  });

  const refreshInputs = () => ({ 'client-id': 'id', 'client-secret': 'secret', 'refresh-token': 'refresh', 'publisher-id': PUBLISHER, 'item-id': ITEM, zip: zipFile('1.0.1') });

  it('reports an unreachable token endpoint with its cause', async () => {
    const run = await runAction(refreshInputs(), { CWS_TOKEN_ENDPOINT: `http://localhost:${await closedPort()}/token` });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /^::error::Exchanging the refresh token failed: .*ECONNREFUSED/m);
  });

  it('refuses a redirect from the token endpoint, so the refresh token is not sent on', async () => {
    store.on('POST /token', { status: 307, headers: { Location: `${store.base}/stolen` } });
    const run = await runAction(refreshInputs(), { CWS_TOKEN_ENDPOINT: `${store.base}/token` });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /token endpoint answered with a redirect \(HTTP 307\), which the action refuses to follow/);
    assert.deepEqual(
      store.requests.map((request) => request.key),
      ['POST /token'],
    );
  });

  it('reports a token response without an access token', async () => {
    store.on('POST /token', { body: { token_type: 'Bearer' } });
    const run = await runAction(refreshInputs(), { CWS_TOKEN_ENDPOINT: `${store.base}/token` });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /Google answered the refresh token request without an access token\./);
  });

  it('rejects an access token that is not a header value without printing it', async () => {
    const key = '{"type": "service_account",\n "private_key": "-----BEGIN PRIVATE KEY-----"}';
    const run = await runAction(baseInputs('1.0.0', { 'access-token': key }));
    assert.equal(run.code, 1);
    assert.match(run.stdout, /Input access-token contains spaces or control characters/);
    assert.ok(!withoutMaskLines(run.stdout).includes('PRIVATE KEY'));
    assert.equal(store.requests.length, 0);
  });

  it('refuses to send the token anywhere but Google or a loopback test server', async () => {
    for (const url of ['https://example.com', 'http://10.0.0.1:8080', 'http://localhost.example.com']) {
      const run = await runAction(baseInputs('1.0.0'), { CWS_API_BASE: url });
      assert.equal(run.code, 1);
      assert.match(run.stdout, /CWS_API_BASE is a test setting and may only point to http:\/\/127\.0\.0\.1/);
    }
    const notUrl = await runAction(baseInputs('1.0.0'), { CWS_TOKEN_ENDPOINT: 'not a url' });
    assert.match(notUrl.stdout, /CWS_TOKEN_ENDPOINT is not a URL\./);
    assert.equal(store.requests.length, 0);
  });
});
