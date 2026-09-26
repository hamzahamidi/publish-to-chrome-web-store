import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { type PublishOptions, type PublishResult, publishToStore, raiseRollout } from '../src/store.ts';
import { closedPort, extensionZip, FETCH, ITEM, type MockStore, PUBLISH, publishedAt, PUBLISHER, ROLLOUT, startMockStore, storeStatus, UPLOAD } from './helpers.ts';

let store: MockStore;
before(async () => {
  store = await startMockStore();
});
afterEach(() => store.reset());
after(() => store.close());

function publish(version: string, options: Partial<PublishOptions> = {}) {
  const lines: string[] = [];
  const warnings: string[] = [];
  const promise = publishToStore({
    token: 'test-token',
    publisherId: PUBLISHER,
    itemId: ITEM,
    version,
    zip: extensionZip(version),
    apiBase: store.base,
    pollIntervalMs: 0,
    pollAttempts: 3,
    log: (line) => lines.push(line),
    warn: (line) => warnings.push(line),
    ...options,
  });
  return Object.assign(promise, { lines, warnings });
}

const calls = () => store.requests.map((request) => request.key);

async function rejection(promise: Promise<PublishResult>): Promise<ActionError> {
  const error: unknown = await promise.then(
    () => assert.fail('expected the call to fail'),
    (error: unknown) => error,
  );
  assert.ok(error instanceof ActionError, `expected ActionError, got ${error}`);
  return error;
}

describe('publishToStore', () => {
  it('uploads the package, then submits it for review with the bearer token', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED', crxVersion: '1.0.1' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const run = publish('1.0.1');
    assert.deepEqual(await run, { result: 'submitted', state: 'PENDING_REVIEW' });
    assert.deepEqual(calls(), [FETCH, UPLOAD, PUBLISH, FETCH]);
    assert.ok(store.requests.every((request) => request.auth === 'Bearer test-token'));
    assert.equal(store.requests[1]!.size, extensionZip('1.0.1').length);
    assert.deepEqual(JSON.parse(store.requests[2]!.body), { publishType: 'DEFAULT_PUBLISH' });
    assert.equal(store.requests[2]!.contentType, 'application/json');
    assert.ok(run.lines.includes('Submitted version 1.0.1 for review. Store state: PENDING_REVIEW.'));
  });

  it('sends the staged publish type when asked', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    await publish('1.0.0', { publishType: 'STAGED_PUBLISH' });
    assert.deepEqual(JSON.parse(store.requests[2]!.body), { publishType: 'STAGED_PUBLISH' });
  });

  it('uploads without submitting when submit is false', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    assert.deepEqual(await publish('1.0.1', { submit: false }), { result: 'uploaded', state: '' });
    assert.deepEqual(calls(), [FETCH, UPLOAD]);
  });

  it('reports what would happen on a dry run and writes nothing', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    const run = publish('1.0.1', { dryRun: true });
    assert.deepEqual(await run, { result: 'dry-run', state: '' });
    assert.deepEqual(calls(), [FETCH]);
    assert.ok(run.lines.includes('Dry run: version 1.0.1 would be uploaded and submitted for review. Nothing was sent to the store.'));

    store.reset();
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    const draft = publish('1.0.1', { dryRun: true, submit: false });
    await draft;
    assert.ok(draft.lines.includes('Dry run: version 1.0.1 would be uploaded as a draft. Nothing was sent to the store.'));
  });

  it('still refuses on a dry run when the real run would fail', async () => {
    store.on(FETCH, storeStatus({ submitted: '1.0.0', submittedState: 'PENDING_REVIEW' }));
    await rejection(publish('1.0.1', { dryRun: true }));
    assert.deepEqual(calls(), [FETCH]);
  });

  it('polls while the upload is processing and submits once it succeeds', async () => {
    store.on(
      FETCH,
      storeStatus({ published: '1.0.0' }),
      storeStatus({ published: '1.0.0', lastAsyncUploadState: 'IN_PROGRESS' }),
      storeStatus({ published: '1.0.0', lastAsyncUploadState: 'SUCCEEDED' }),
    );
    store.on(UPLOAD, { body: { uploadState: 'IN_PROGRESS' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    assert.equal((await publish('1.0.1')).result, 'submitted');
    assert.deepEqual(calls(), [FETCH, UPLOAD, FETCH, FETCH, PUBLISH, FETCH]);
  });

  it('does nothing when the version is already published, so re-runs are safe', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.1' }));
    assert.deepEqual(await publish('1.0.1'), { result: 'skipped', state: 'PUBLISHED' });
    assert.deepEqual(calls(), [FETCH]);
  });

  it('finds the version in any distribution channel, such as a partial rollout', async () => {
    store.on(FETCH, {
      body: {
        publishedItemRevisionStatus: {
          state: 'PUBLISHED',
          distributionChannels: [
            { deployPercentage: 90, crxVersion: '1.0.0' },
            { deployPercentage: 10, crxVersion: '1.0.1' },
          ],
        },
      },
    });
    assert.equal((await publish('1.0.1')).result, 'skipped');
  });

  for (const state of ['PENDING_REVIEW', 'STAGED', 'PUBLISHED_TO_TESTERS']) {
    it(`does nothing when the version is already ${state}`, async () => {
      store.on(FETCH, storeStatus({ published: '1.0.0', submitted: '1.0.1', submittedState: state }));
      assert.deepEqual(await publish('1.0.1'), { result: 'skipped', state });
      assert.deepEqual(calls(), [FETCH]);
    });
  }

  for (const state of ['REJECTED', 'CANCELLED']) {
    it(`fails instead of reporting success when this version was ${state}`, async () => {
      store.on(FETCH, storeStatus({ published: '1.0.0', submitted: '1.0.1', submittedState: state }));
      const error = await rejection(publish('1.0.1'));
      assert.match(error.message, new RegExp(`Version 1\\.0\\.1 is ${state}`));
      assert.match(error.details ?? '', /Resubmit it from the Developer Dashboard/);
      assert.deepEqual(calls(), [FETCH]);
    });

    it(`uploads a new version when the previous submission was ${state}`, async () => {
      store.on(FETCH, storeStatus({ published: '1.0.0', submitted: '1.0.1', submittedState: state }));
      store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
      store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
      assert.equal((await publish('1.0.2')).result, 'submitted');
      assert.deepEqual(calls(), [FETCH, UPLOAD, PUBLISH, FETCH]);
    });
  }

  it('refuses to upload while another version is in review', async () => {
    store.on(FETCH, storeStatus({ submitted: '1.0.0', submittedState: 'PENDING_REVIEW' }));
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /Version 1\.0\.0 is still in review/);
    assert.deepEqual(calls(), [FETCH]);
  });

  it('asks for a manual publish when another version is approved but not published', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0', submitted: '1.0.1', submittedState: 'STAGED' }));
    const error = await rejection(publish('1.0.2'));
    assert.match(error.message, /Version 1\.0\.1 is approved but not published yet/);
    assert.match(error.details ?? '', /Publish or cancel it in the Developer Dashboard/);
    assert.deepEqual(calls(), [FETCH]);
  });

  it('fails when the upload fails', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { body: { uploadState: 'FAILED' } });
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /ended in state FAILED/);
    assert.match(error.details ?? '', /Store response: .*"uploadState":"FAILED"/);
    assert.deepEqual(calls(), [FETCH, UPLOAD]);
  });

  it('gives up when the upload never finishes processing, without submitting', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }), storeStatus({ published: '1.0.0', lastAsyncUploadState: 'IN_PROGRESS' }));
    store.on(UPLOAD, { body: { uploadState: 'IN_PROGRESS' } });
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /^The store was still processing version 1\.0\.1 after \d+ s\. This run did not submit it\.$/);
    assert.match(error.details ?? '', /submit the draft there or re-run this job/);
    assert.deepEqual(calls(), [FETCH, UPLOAD, FETCH, FETCH, FETCH]);
  });

  it('reports the store error message and path when a call is rejected', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { status: 400, body: { error: { code: 400, status: 'FAILED_PRECONDITION', message: 'Item is in review' } } });
    const error = await rejection(publish('1.0.1'));
    assert.equal(error.message, `POST /upload/v2/publishers/${PUBLISHER}/items/${ITEM}:upload returned HTTP 400: Item is in review`);
  });

  for (const [status, hint] of [
    [401, /invalid or expired/],
    [403, /lacks the https:\/\/www\.googleapis\.com\/auth\/chromewebstore scope, the Chrome Web Store API is not enabled/],
    [404, /Check publisher-id and item-id/],
  ] as Array<[number, RegExp]>) {
    it(`explains an HTTP ${status} from the store`, async () => {
      store.on(FETCH, { status, body: { error: { code: status, message: 'nope' } } });
      const error = await rejection(publish('1.0.1'));
      assert.match(error.message, new RegExp(`returned HTTP ${status}: nope`));
      assert.match(error.details ?? '', hint);
    });
  }

  for (const [reason, hint] of [
    ['ACCESS_TOKEN_SCOPE_INSUFFICIENT', /set access_token_scopes to it/],
    ['SERVICE_DISABLED', /Enable chromewebstore\.googleapis\.com on the Google Cloud project/],
  ] as Array<[string, RegExp]>) {
    it(`names the cause of a 403 with reason ${reason}`, async () => {
      store.on(FETCH, { status: 403, body: { error: { code: 403, message: 'denied', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason }] } } });
      const error = await rejection(publish('1.0.1'));
      assert.match(error.details ?? '', hint);
    });
  }

  it('mentions the visibility rule when the publish call is refused', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { status: 400, body: { error: { code: 400, message: 'Publish condition not met' } } });
    const error = await rejection(publish('1.0.0'));
    assert.match(error.message, /:publish returned HTTP 400: Publish condition not met/);
    assert.match(error.details ?? '', /visibility of the item was changed in the Developer Dashboard/);
  });

  it('refuses to follow a redirect, so the token stays with the store', async () => {
    store.on(FETCH, { status: 307, headers: { Location: `${store.base}/elsewhere` } });
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /fetchStatus answered with a redirect \(HTTP 307\), which the action refuses to follow/);
    assert.deepEqual(calls(), [FETCH]);
  });

  it('reports a response that breaks off while it is read', async () => {
    store.on(FETCH, { partial: true });
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /fetchStatus returned HTTP 200, then failed while reading the response: \S/);
  });

  it('retries a status check that fails temporarily while the upload is processing', async () => {
    store.on(
      FETCH,
      storeStatus({ published: '1.0.0' }),
      { status: 503, body: { error: { code: 503, message: 'Backend Error' } } },
      storeStatus({ published: '1.0.0', lastAsyncUploadState: 'SUCCEEDED' }),
    );
    store.on(UPLOAD, { body: { uploadState: 'IN_PROGRESS' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const run = publish('1.0.1');
    assert.equal((await run).result, 'submitted');
    assert.deepEqual(calls(), [FETCH, UPLOAD, FETCH, FETCH, PUBLISH, FETCH]);
    assert.ok(run.lines.some((line) => line.startsWith('Status check failed, trying again:')));
  });

  it('does not retry a status check that the store refuses', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }), { status: 403, body: { error: { code: 403, message: 'denied' } } });
    store.on(UPLOAD, { body: { uploadState: 'IN_PROGRESS' } });
    await rejection(publish('1.0.1'));
    assert.deepEqual(calls(), [FETCH, UPLOAD, FETCH]);
  });

  for (const [published, version] of [
    ['1.0.1', '1.0.0'],
    ['1.2', '1.2.0'],
    ['2.0.0', '1.9.9.9'],
  ] as Array<[string, string]>) {
    it(`refuses version ${version} when ${published} is published, before uploading`, async () => {
      store.on(FETCH, storeStatus({ published }));
      const error = await rejection(publish(version));
      assert.equal(error.message, `Version ${version} is not higher than the published version ${published}.`);
      assert.match(error.details ?? '', /Increase version in manifest\.json/);
      assert.deepEqual(calls(), [FETCH]);
    });
  }

  it('refuses a version that is not higher on a dry run too', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.1' }));
    await rejection(publish('1.0.0', { dryRun: true }));
  });

  it('warns about a taken down or warned item and still submits', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0', takenDown: true, warned: true }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const run = publish('1.0.1');
    assert.equal((await run).result, 'submitted');
    assert.equal(run.warnings.length, 2);
    assert.match(run.warnings[0] ?? '', /taken down for a policy violation/);
    assert.match(run.warnings[1] ?? '', /policy warning on this item/);
  });

  it('reports a response that is not JSON', async () => {
    store.on(FETCH, { status: 502, body: '<html>Bad gateway</html>' });
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /returned HTTP 502: <html>Bad gateway<\/html>/);
  });

  it('reports a successful response that is not JSON', async () => {
    store.on(FETCH, { body: 'ok' });
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /fetchStatus returned a response that is not JSON: ok/);
  });

  it('reports the state of this version from the status read after submitting', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }), storeStatus({ published: '1.0.0', submitted: '1.0.1', submittedState: 'PENDING_REVIEW' }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { itemId: ITEM } });
    assert.deepEqual(await publish('1.0.1'), { result: 'submitted', state: 'PENDING_REVIEW' });
  });

  it('fails when another run replaced the package before this run submitted it', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }), storeStatus({ published: '1.0.0', submitted: '1.0.2', submittedState: 'PENDING_REVIEW' }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const error = await rejection(publish('1.0.1'));
    assert.equal(error.message, 'The store has version 1.0.2 in review, not 1.0.1. Another run replaced the uploaded package before this run submitted it.');
    assert.match(error.details ?? '', /concurrency group/);
  });

  it('keeps a submission that went through when the status read afterwards fails', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }), { status: 503, body: { error: { code: 503, message: 'Backend Error' } } });
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const run = publish('1.0.1');
    assert.deepEqual(await run, { result: 'submitted', state: 'PENDING_REVIEW' });
    assert.match(run.warnings[0] ?? '', /The submission went through, but reading the store status afterwards failed/);
  });

  it('suggests a re-run, not the visibility rule, when the publish call fails temporarily', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { status: 503, body: { error: { code: 503, message: 'Backend Error' } } });
    const error = await rejection(publish('1.0.0'));
    assert.match(error.details ?? '', /Re-running is safe/);
    assert.doesNotMatch(error.details ?? '', /visibility/);
  });

  it('prints a store warning that has no reason', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ description: 'check the listing' }] } } });
    const run = publish('1.0.0');
    await run;
    assert.deepEqual(run.warnings, ['Chrome Web Store warning: check the listing']);
  });

  it('waits for an earlier upload that is still processing before uploading', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0', lastAsyncUploadState: 'IN_PROGRESS' }), storeStatus({ published: '1.0.0', lastAsyncUploadState: 'FAILED' }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED', crxVersion: '1.0.1' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    const run = publish('1.0.1');
    assert.equal((await run).result, 'submitted');
    assert.deepEqual(calls(), [FETCH, FETCH, UPLOAD, PUBLISH, FETCH]);
    assert.ok(run.lines.includes('An earlier upload is processing, checking again in 0 s.'));
  });

  it('uploads nothing while an earlier upload never finishes processing', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0', lastAsyncUploadState: 'IN_PROGRESS' }));
    const error = await rejection(publish('1.0.1'));
    assert.match(error.message, /^An earlier upload was still processing after \d+ s, so this run uploaded nothing\.$/);
    assert.ok(!calls().includes(UPLOAD));
  });

  it('mentions an earlier upload in progress on a dry run without waiting for it', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0', lastAsyncUploadState: 'IN_PROGRESS' }));
    const run = publish('1.0.1', { dryRun: true });
    assert.equal((await run).result, 'dry-run');
    assert.deepEqual(calls(), [FETCH]);
    assert.ok(run.lines.includes('An earlier upload is still processing in the store. A real run would wait for it before uploading.'));
  });

  it('refuses to submit when the store accepted a package with another version', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED', crxVersion: '1.0.2' } });
    const error = await rejection(publish('1.0.1'));
    assert.equal(error.message, 'The store accepted a package with version 1.0.2, not 1.0.1. This run did not submit it.');
    assert.deepEqual(calls(), [FETCH, UPLOAD]);
  });

  it('points to the crx input when an opted-in item refuses a ZIP', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { status: 400, body: { error: { code: 400, message: 'PKG_MUST_UPDATE_AS_CRX: You must update your item with a crx package.' } } });
    const error = await rejection(publish('1.0.1'));
    assert.match(error.details ?? '', /opted in to Verified CRX Uploads, so the store only accepts a CRX signed with your key\. Pass it through the crx input\./);
  });

  it('sends a CRX with the raw upload headers and explains a refused CRX', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { status: 400, body: { error: { code: 400, message: 'The uploaded package was invalid.' } } });
    const error = await rejection(publish('1.0.1', { crxFileName: 'ext.crx' }));
    assert.equal(store.requests[1]!.uploadProtocol, 'raw');
    assert.equal(store.requests[1]!.uploadFileName, 'ext.crx');
    assert.match(error.details ?? '', /signed with the key registered on its Package tab/);
  });

  it('never tells a CRX upload to use the crx input', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { status: 400, body: { error: { code: 400, message: 'PKG_MUST_UPDATE_AS_CRX: You must update your item with a crx package.' } } });
    const error = await rejection(publish('1.0.1', { crxFileName: 'ext.crx' }));
    assert.doesNotMatch(error.details ?? '', /Pass it through the crx input/);
    assert.match(error.details ?? '', /Package tab/);
  });

  it('explains a CRX upload that ends in FAILED', async () => {
    store.on(FETCH, storeStatus({ published: '1.0.0' }));
    store.on(UPLOAD, { body: { uploadState: 'FAILED' } });
    const error = await rejection(publish('1.0.1', { crxFileName: 'ext.crx' }));
    assert.match(error.details ?? '', /^Store response: .*\n.*Package tab\.$/s);
  });

  it('sends only the publish options that were asked for', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW' } });
    await publish('1.0.0', { deployPercentage: 0, blockOnWarnings: true });
    assert.deepEqual(JSON.parse(store.requests[2]!.body), { publishType: 'DEFAULT_PUBLISH', deployInfos: [{ deployPercentage: 0 }], blockOnWarnings: true });
  });

  it('shows the details of a submission blocked on warnings', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { status: 400, body: { error: { code: 400, message: 'Validation warnings.', details: [{ '@type': 'type.googleapis.com/google.chrome.webstore.v2.Warning', reason: 'BROAD_HOST_PERMISSION', description: 'uses a broad host permission' }] } } });
    const error = await rejection(publish('1.0.0', { blockOnWarnings: true }));
    assert.match(error.message, /returned HTTP 400: Validation warnings\. Details: \[.*BROAD_HOST_PERMISSION.*broad host permission/);
  });

  it('raises the rollout when the version is already published below the target', async () => {
    store.on(FETCH, publishedAt('1.0.1', 10));
    store.on(ROLLOUT, { body: {} });
    const run = publish('1.0.1', { deployPercentage: 40 });
    assert.deepEqual(await run, { result: 'raised', state: 'PUBLISHED' });
    assert.deepEqual(calls(), [FETCH, ROLLOUT]);
    assert.deepEqual(JSON.parse(store.requests[1]!.body), { deployPercentage: 40 });
  });

  it('leaves a rollout alone when it already reaches the target', async () => {
    store.on(FETCH, publishedAt('1.0.1', 40));
    const run = publish('1.0.1', { deployPercentage: 40 });
    assert.deepEqual(await run, { result: 'skipped', state: 'PUBLISHED' });
    assert.deepEqual(calls(), [FETCH]);
    assert.ok(run.lines.includes('Version 1.0.1 already reaches 40% of users. Nothing to raise.'));
  });

  it('asks the store to raise when it does not report a percentage, and reports a dry run without raising', async () => {
    store.on(FETCH, publishedAt('1.0.1'));
    store.on(ROLLOUT, { body: {} });
    assert.equal((await publish('1.0.1', { deployPercentage: 60 })).result, 'raised');
    store.reset();
    store.on(FETCH, publishedAt('1.0.1', 10));
    const dry = publish('1.0.1', { deployPercentage: 60, dryRun: true });
    assert.deepEqual(await dry, { result: 'dry-run', state: 'PUBLISHED' });
    assert.deepEqual(calls(), [FETCH]);
    assert.ok(dry.lines.includes('Dry run: version 1.0.1 would go from 10% to 60% of users. Nothing was sent to the store.'));
  });

  it('explains Google\'s rollout rule when the store refuses to raise', async () => {
    store.on(FETCH, publishedAt('1.0.1', 10));
    store.on(ROLLOUT, { status: 400, body: { error: { code: 400, message: 'Item is not eligible.' } } });
    const error = await rejection(publish('1.0.1', { deployPercentage: 50 }));
    assert.match(error.details ?? '', /more than 10,000 seven-day active users, and only upward/);
  });

  it('raises the newest published version in raise-only mode, and refuses when nothing is published', async () => {
    store.on(FETCH, { body: { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '1.9.0', deployPercentage: 100 }, { crxVersion: '1.10.0', deployPercentage: 5 }] } } });
    store.on(ROLLOUT, { body: {} });
    const lines: string[] = [];
    const raised = await raiseRollout({ token: 'test-token', publisherId: PUBLISHER, itemId: ITEM, deployPercentage: 25, apiBase: store.base, log: (line) => lines.push(line) });
    assert.deepEqual(raised, { result: 'raised', state: 'PUBLISHED', version: '1.10.0' });
    assert.ok(lines.includes('Raised version 1.10.0 from 5% to 25% of users.'));
    store.reset();
    store.on(FETCH, storeStatus());
    await assert.rejects(
      raiseRollout({ token: 'test-token', publisherId: PUBLISHER, itemId: ITEM, deployPercentage: 25, apiBase: store.base }),
      (error) => error instanceof ActionError && /No version of this item is published/.test(error.message),
    );
  });

  it('tells a refused skip-review how to recover', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { status: 400, body: { error: { code: 400, message: 'Item requires review.' } } });
    const error = await rejection(publish('1.0.0', { skipReview: true }));
    assert.match(error.details ?? '', /With skip-review the store refuses a submission that needs review/);
    store.reset();
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { status: 400, body: { error: { code: 400, message: 'Bad request.' } } });
    assert.doesNotMatch((await rejection(publish('1.0.0'))).details ?? '', /skip-review|10,000/);
  });

  it('passes store warnings on', async () => {
    store.on(FETCH, storeStatus());
    store.on(UPLOAD, { body: { uploadState: 'SUCCEEDED' } });
    store.on(PUBLISH, { body: { state: 'PENDING_REVIEW', warningInfo: { warnings: [{ reason: 'BROAD_HOST_PERMISSION', description: 'uses a broad host permission' }] } } });
    const run = publish('1.0.0');
    await run;
    assert.deepEqual(run.warnings, ['Chrome Web Store warning BROAD_HOST_PERMISSION: uses a broad host permission']);
  });

  it('reports a network failure with its cause', async () => {
    const error = await rejection(publish('1.0.1', { apiBase: `http://localhost:${await closedPort()}` }));
    assert.match(error.message, /^GET \/v2\/publishers\/pub-1\/items\/[a-p]+:fetchStatus failed: .*ECONNREFUSED/);
  });
});
