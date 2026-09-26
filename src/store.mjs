import { ActionError, networkReason } from './errors.mjs';
import { compareVersions, isExtensionVersion } from './zip.mjs';

export const STORE_API = 'https://chromewebstore.googleapis.com';

const SETTLED_STATES = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);
const UPLOADING_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const REASON_HINTS = {
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'The token lacks the https://www.googleapis.com/auth/chromewebstore scope. With google-github-actions/auth, set access_token_scopes to it.',
  SERVICE_DISABLED: 'Enable chromewebstore.googleapis.com on the Google Cloud project that owns the service account or the OAuth client.',
};
const STATUS_HINTS = {
  401: 'The store rejected the access token as invalid or expired. Mint it in the same job, with a lifetime longer than the job needs.',
  403: 'The token lacks the https://www.googleapis.com/auth/chromewebstore scope, the Chrome Web Store API is not enabled on the project behind the token, the account is neither the publisher nor its linked service account, or publisher-id is wrong.',
  404: 'The store does not know this item. Check publisher-id and item-id.',
};
const PUBLISH_HINT = 'If the visibility of the item was changed in the Developer Dashboard, publish once by hand with the new visibility. Until then the API cannot publish it.';
const RERUN_HINT = 'The store may have received the request. Re-running is safe: the action reads the store status first.';
const REVIEW_STATES = new Set(['PENDING_REVIEW', 'STAGED']);

export async function publishToStore({
  token,
  publisherId,
  itemId,
  version,
  zip,
  submit = true,
  dryRun = false,
  publishType = 'DEFAULT_PUBLISH',
  apiBase = STORE_API,
  pollIntervalMs = 10_000,
  pollAttempts = 30,
  statusRetries = 2,
  requestTimeoutMs = 120_000,
  uploadTimeoutMs = 600_000,
  log = () => {},
  warn = () => {},
}) {
  const item = `publishers/${publisherId}/items/${itemId}`;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function call(method, path, { timeoutMs = requestTimeoutMs, hint, ...init } = {}) {
    let response;
    let text;
    try {
      response = await fetch(apiBase + path, {
        method,
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...init.headers },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new ActionError(`${method} ${path} failed: ${networkReason(error)}`, undefined, { retryable: true });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new ActionError(`${method} ${path} answered with a redirect (HTTP ${response.status}), which the action refuses to follow.`);
    }
    try {
      text = await response.text();
    } catch (error) {
      throw new ActionError(
        `${method} ${path} returned HTTP ${response.status}, then failed while reading the response: ${networkReason(error)}`,
        method === 'POST' ? RERUN_HINT : undefined,
        { retryable: true },
      );
    }
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const reason = body?.error?.message ?? text.slice(0, 2000);
      const details = Array.isArray(body?.error?.details) ? body.error.details : [];
      const detailReason = details.find((detail) => typeof detail?.reason === 'string')?.reason;
      const retryable = RETRYABLE_STATUSES.has(response.status);
      const fallback = retryable ? (method === 'POST' ? RERUN_HINT : undefined) : hint;
      throw new ActionError(`${method} ${path} returned HTTP ${response.status}: ${reason}`, REASON_HINTS[detailReason] ?? STATUS_HINTS[response.status] ?? fallback, { retryable });
    }
    if (body === undefined || body === null || typeof body !== 'object') {
      throw new ActionError(`${method} ${path} returned a response that is not JSON: ${text.slice(0, 2000)}`);
    }
    return body;
  }

  const fetchStatus = () => call('GET', `/v2/${item}:fetchStatus`);

  const status = await fetchStatus();
  const published = status.publishedItemRevisionStatus;
  const submitted = status.submittedItemRevisionStatus;
  const publishedVersions = versionsOf(published);
  const submittedVersions = versionsOf(submitted);
  log(`Store: published ${publishedVersions.join(', ') || 'none'}, submitted ${submittedVersions.join(', ') || 'none'}${submitted?.state ? ` (${submitted.state})` : ''}.`);
  if (status.takenDown === true) warn('The Chrome Web Store reports this item as taken down for a policy violation. A new version must fix the violation to pass review.');
  if (status.warned === true) warn('The Chrome Web Store reports a policy warning on this item. It will be taken down if the violation is not resolved.');

  if (publishedVersions.includes(version)) {
    log(`Version ${version} is already published. Nothing to upload.`);
    return { result: 'skipped', state: published.state ?? 'PUBLISHED' };
  }
  if (submittedVersions.includes(version)) {
    if (SETTLED_STATES.has(submitted.state)) {
      log(`Version ${version} is already ${submitted.state}. Nothing to upload.`);
      return { result: 'skipped', state: submitted.state };
    }
    throw new ActionError(
      `Version ${version} is ${submitted.state} in the Chrome Web Store.`,
      'Resubmit it from the Developer Dashboard, or fix the cause and release a new version.',
    );
  }
  const highest = publishedVersions.filter(isExtensionVersion).sort(compareVersions).at(-1);
  if (highest && compareVersions(version, highest) <= 0) {
    throw new ActionError(`Version ${version} is not higher than the published version ${highest}.`, 'The store only accepts a higher version. Increase version in manifest.json.');
  }
  if (submitted?.state === 'PENDING_REVIEW') {
    throw new ActionError(
      `Version ${submittedVersions.join(', ')} is still in review. The store accepts no new package until the review ends.`,
      'Wait for the review to finish, or cancel it in the Developer Dashboard, then re-run this job.',
    );
  }
  if (submitted?.state === 'STAGED') {
    throw new ActionError(
      `Version ${submittedVersions.join(', ')} is approved but not published yet.`,
      'Publish or cancel it in the Developer Dashboard, then re-run this job.',
    );
  }

  if (dryRun) {
    log(`Dry run: version ${version} would be uploaded${submit ? ' and submitted for review' : ' as a draft'}. Nothing was sent to the store.`);
    return { result: 'dry-run', state: '' };
  }

  const upload = await call('POST', `/upload/v2/${item}:upload`, { body: zip, timeoutMs: uploadTimeoutMs });
  const processingStarted = Date.now();
  let state = upload.uploadState;
  let last = upload;
  let failures = 0;
  for (let attempt = 1; UPLOADING_STATES.has(state) && attempt <= pollAttempts; attempt++) {
    log(`Upload is processing, checking again in ${pollIntervalMs / 1000} s.`);
    await sleep(pollIntervalMs);
    try {
      last = await fetchStatus();
      failures = 0;
      state = last.lastAsyncUploadState;
    } catch (error) {
      failures += 1;
      if (!error.retryable || failures > statusRetries) throw error;
      log(`Status check failed, trying again: ${error.message}`);
    }
  }
  if (UPLOADING_STATES.has(state)) {
    throw new ActionError(
      `The store was still processing version ${version} after ${Math.round((Date.now() - processingStarted) / 1000)} s. This run did not submit it.`,
      'The store may still finish processing it as a draft, or the upload may fail. Check the Developer Dashboard, then submit the draft there or re-run this job.',
    );
  }
  if (state !== 'SUCCEEDED') {
    throw new ActionError(`Upload of version ${version} ended in state ${state ?? 'unknown'}.`, `Store response: ${JSON.stringify(last).slice(0, 2000)}`);
  }
  log(`Uploaded version ${version}.`);
  if (!submit) return { result: 'uploaded', state: '' };

  const publish = await call('POST', `/v2/${item}:publish`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishType }),
    hint: PUBLISH_HINT,
  });
  log(`Submitted version ${version} for review. Store state: ${publish.state ?? 'unknown'}.`);
  const warnings = publish.warningInfo?.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings.slice(0, 20)) {
      const reason = typeof warning?.reason === 'string' ? ` ${warning.reason}` : '';
      warn(`Chrome Web Store warning${reason}: ${warning?.description ?? JSON.stringify(warning)}`.slice(0, 2000));
    }
  }

  let after;
  try {
    after = await fetchStatus();
  } catch (error) {
    warn(`The submission went through, but reading the store status afterwards failed: ${error.message}`);
    return { result: 'submitted', state: publish.state ?? '' };
  }
  const inReview = versionsOf(after.submittedItemRevisionStatus);
  const reviewState = after.submittedItemRevisionStatus?.state;
  if (inReview.length > 0 && !inReview.includes(version) && REVIEW_STATES.has(reviewState)) {
    throw new ActionError(
      `The store has version ${inReview.join(', ')} in review, not ${version}. Another run replaced the uploaded package before this run submitted it.`,
      'Let one run publish at a time, for example with a concurrency group on the job, then release again.',
    );
  }
  return { result: 'submitted', state: (inReview.includes(version) && reviewState) || publish.state || '' };
}

function versionsOf(revision) {
  return (revision?.distributionChannels ?? []).map((channel) => channel.crxVersion).filter((version) => typeof version === 'string');
}
