import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { extensionZip, FETCH, PUBLISH, startMockStore, storeStatus, UPLOAD } from './helpers.mjs';

const ZIP = 'self-test.zip';
const REQUESTS = 'self-test-requests.json';
const PORT = 'self-test-port';
const VERSION = '1.2.3';

const command = process.argv[2];

if (command === 'start') {
  rmSync(PORT, { force: true });
  const log = openSync('self-test-server.log', 'w');
  spawn(process.execPath, [import.meta.filename, 'serve'], { detached: true, stdio: ['ignore', log, log] }).unref();
  for (let i = 0; i < 50 && !existsSync(PORT); i++) await sleep(100);
  if (!existsSync(PORT)) {
    console.error(readFileSync('self-test-server.log', 'utf8'));
    console.error('The mock store did not start within 5 s.');
    process.exit(1);
  }
  const base = `http://127.0.0.1:${readFileSync(PORT, 'utf8')}`;
  appendFileSync(process.env.GITHUB_ENV, `CWS_API_BASE=${base}\n`);
  console.log(`Mock store listening on ${base}.`);
} else if (command === 'serve') {
  writeFileSync(ZIP, extensionZip(VERSION));
  const store = await startMockStore({ onRequest: (_, requests) => writeFileSync(REQUESTS, JSON.stringify(requests, null, 2)) });
  store.on(FETCH, storeStatus({ published: '1.2.2' }));
  store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED', crxVersion: VERSION } });
  store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
  writeFileSync(`${PORT}.tmp`, new URL(store.base).port);
  renameSync(`${PORT}.tmp`, PORT);
} else if (command === 'verify') {
  assert.deepEqual(
    { result: process.env.RESULT, state: process.env.STATE, version: process.env.VERSION },
    { result: 'submitted', state: 'PENDING_REVIEW', version: VERSION },
  );
  const requests = JSON.parse(readFileSync(REQUESTS, 'utf8'));
  assert.deepEqual(
    requests.map((request) => request.key),
    [FETCH, UPLOAD, PUBLISH, FETCH],
  );
  assert.ok(requests.every((request) => request.auth === 'Bearer self-test-token'));
  assert.equal(requests[1].size, readFileSync(ZIP).length);
  assert.deepEqual(JSON.parse(requests[2].body), { publishType: 'DEFAULT_PUBLISH' });
  console.log('The action made the expected four calls and set the expected outputs.');
} else {
  console.error('Usage: node test/self-test.mjs start|serve|verify');
  process.exit(2);
}
