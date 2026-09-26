import { ActionError, networkReason } from './errors.ts';
import { compareVersions, isExtensionVersion } from './zip.ts';

export const STORE_API = 'https://chromewebstore.googleapis.com';

export type PublishType = 'DEFAULT_PUBLISH' | 'STAGED_PUBLISH';

export interface PublishOptions {
  token: string;
  publisherId: string;
  itemId: string;
  version: string;
  zip: Buffer;
  crxFileName?: string;
  submit?: boolean;
  dryRun?: boolean;
  publishType?: PublishType;
  deployPercentage?: number;
  skipReview?: boolean;
  blockOnWarnings?: boolean;
  apiBase?: string;
  pollIntervalMs?: number;
  pollAttempts?: number;
  statusRetries?: number;
  requestTimeoutMs?: number;
  uploadTimeoutMs?: number;
  log?: (line: string) => void;
  warn?: (line: string) => void;
}

export interface PublishResult {
  result: 'submitted' | 'uploaded' | 'skipped' | 'dry-run' | 'raised';
  state: string;
}

export interface RolloutOptions {
  token: string;
  publisherId: string;
  itemId: string;
  deployPercentage: number;
  dryRun?: boolean;
  apiBase?: string;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
}

interface ClientOptions {
  token: string;
  apiBase: string;
  requestTimeoutMs: number;
  crxFileName?: string;
}

type Call = <T>(method: string, path: string, options?: CallOptions) => Promise<T>;

interface DistributionChannel {
  crxVersion?: unknown;
  deployPercentage?: number;
}

interface RevisionStatus {
  state?: string;
  distributionChannels?: DistributionChannel[];
}

interface ItemStatus {
  publishedItemRevisionStatus?: RevisionStatus;
  submittedItemRevisionStatus?: RevisionStatus;
  lastAsyncUploadState?: string;
  takenDown?: boolean;
  warned?: boolean;
}

interface UploadResponse {
  uploadState?: string;
  crxVersion?: unknown;
}

interface PublishResponse {
  state?: string;
  warningInfo?: { warnings?: Array<{ reason?: unknown; description?: unknown }> };
}

interface GoogleError {
  error?: { message?: string; details?: Array<{ '@type'?: unknown; reason?: unknown }> };
}

interface CallOptions extends RequestInit {
  timeoutMs?: number;
  hint?: string;
}

const SETTLED_STATES = new Set(['PENDING_REVIEW', 'STAGED', 'PUBLISHED', 'PUBLISHED_TO_TESTERS']);
const UPLOADING_STATES = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS']);
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const REASON_HINTS: Record<string, string> = {
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'The token lacks the https://www.googleapis.com/auth/chromewebstore scope. With google-github-actions/auth, set access_token_scopes to it.',
  SERVICE_DISABLED: 'Enable chromewebstore.googleapis.com on the Google Cloud project that owns the service account or the OAuth client.',
};
const STATUS_HINTS: Record<number, string> = {
  401: 'The store rejected the access token as invalid or expired. Mint it in the same job, with a lifetime longer than the job needs.',
  403: 'The token lacks the https://www.googleapis.com/auth/chromewebstore scope, the Chrome Web Store API is not enabled on the project behind the token, the account is neither the publisher nor its linked service account, or publisher-id is wrong.',
  404: 'The store does not know this item. Check publisher-id and item-id.',
};
const PUBLISH_HINT = 'If the visibility of the item was changed in the Developer Dashboard, publish once by hand with the new visibility. Until then the API cannot publish it.';
const RERUN_HINT = 'The store may have received the request. Re-running is safe: the action reads the store status first.';
const REVIEW_STATES = new Set(['PENDING_REVIEW', 'STAGED']);
const MUST_USE_CRX = /PKG_MUST_UPDATE_AS_CRX|update your item with a crx/i;
const USE_CRX_HINT = 'This item is opted in to Verified CRX Uploads, so the store only accepts a CRX signed with your key. Pass it through the crx input.';
const CRX_REFUSED_HINT = 'If the store refused the CRX itself, check that the item is opted in to Verified CRX Uploads and that the CRX is signed with the key registered on its Package tab.';
const ROLLOUT_HINT = 'Google lets the API set a rollout percentage only for items with more than 10,000 seven-day active users, and only upward.';

function storeClient({ token, apiBase, requestTimeoutMs, crxFileName }: ClientOptions): Call {
  return async function call<T>(method: string, path: string, { timeoutMs = requestTimeoutMs, hint, ...init }: CallOptions = {}): Promise<T> {
    let response: Response;
    let text: string;
    try {
      response = await fetch(apiBase + path, {
        method,
        ...init,
        headers: { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string> | undefined) },
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
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = undefined;
    }
    if (!response.ok) {
      const googleError = (body as GoogleError | undefined)?.error;
      const reason = googleError?.message ?? text.slice(0, 2000);
      const details = Array.isArray(googleError?.details) ? googleError.details : [];
      const detailReason = details.map((detail) => detail?.reason).find((each): each is string => typeof each === 'string');
      const extra = details.filter((detail) => !String(detail?.['@type'] ?? '').endsWith('google.rpc.ErrorInfo'));
      const retryable = RETRYABLE_STATUSES.has(response.status);
      const fallback = retryable ? (method === 'POST' ? RERUN_HINT : undefined) : hint;
      const crxHint = !crxFileName && MUST_USE_CRX.test(text) ? USE_CRX_HINT : undefined;
      const message = `${method} ${path} returned HTTP ${response.status}: ${reason}${extra.length > 0 ? ` Details: ${JSON.stringify(extra).slice(0, 1500)}` : ''}`;
      throw new ActionError(message, crxHint || (detailReason && REASON_HINTS[detailReason]) || STATUS_HINTS[response.status] || fallback, { retryable });
    }
    if (body === undefined || body === null || typeof body !== 'object') {
      throw new ActionError(`${method} ${path} returned a response that is not JSON: ${text.slice(0, 2000)}`);
    }
    return body as T;
  };
}

type Rollout = { version: string; percentage: number | undefined; state: string };

function rolloutOf(revision: RevisionStatus | undefined, version?: string): Rollout | undefined {
  const channels = (revision?.distributionChannels ?? []).filter((channel): channel is DistributionChannel & { crxVersion: string } => isExtensionVersion(channel?.crxVersion));
  const channel = version ? channels.find((each) => each.crxVersion === version) : channels.sort((a, b) => compareVersions(a.crxVersion, b.crxVersion)).at(-1);
  if (!channel) return undefined;
  return { version: channel.crxVersion, percentage: typeof channel.deployPercentage === 'number' ? channel.deployPercentage : undefined, state: revision?.state ?? 'PUBLISHED' };
}

async function raisePublished(
  call: Call,
  item: string,
  rollout: Rollout,
  deployPercentage: number,
  dryRun: boolean,
  log: (line: string) => void,
): Promise<PublishResult> {
  const current = rollout.percentage === undefined ? 'an unreported share' : `${rollout.percentage}%`;
  if (rollout.percentage !== undefined && rollout.percentage >= deployPercentage) {
    log(`Version ${rollout.version} already reaches ${current} of users. Nothing to raise.`);
    return { result: 'skipped', state: rollout.state };
  }
  if (dryRun) {
    log(`Dry run: version ${rollout.version} would go from ${current} to ${deployPercentage}% of users. Nothing was sent to the store.`);
    return { result: 'dry-run', state: rollout.state };
  }
  await call('POST', `/v2/${item}:setPublishedDeployPercentage`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deployPercentage }),
    hint: ROLLOUT_HINT,
  });
  log(`Raised version ${rollout.version} from ${current} to ${deployPercentage}% of users.`);
  return { result: 'raised', state: rollout.state };
}

export async function raiseRollout({
  token,
  publisherId,
  itemId,
  deployPercentage,
  dryRun = false,
  apiBase = STORE_API,
  requestTimeoutMs = 120_000,
  log = () => {},
}: RolloutOptions): Promise<PublishResult & { version: string }> {
  const item = `publishers/${publisherId}/items/${itemId}`;
  const call = storeClient({ token, apiBase, requestTimeoutMs });
  const status = await call<ItemStatus>('GET', `/v2/${item}:fetchStatus`);
  const rollout = rolloutOf(status.publishedItemRevisionStatus);
  if (!rollout) throw new ActionError('No version of this item is published, so there is no rollout to raise.');
  log(`Store: version ${rollout.version} is published${rollout.percentage === undefined ? '' : ` to ${rollout.percentage}% of users`}.`);
  return { ...(await raisePublished(call, item, rollout, deployPercentage, dryRun, log)), version: rollout.version };
}

export async function publishToStore({
  token,
  publisherId,
  itemId,
  version,
  zip,
  crxFileName,
  submit = true,
  dryRun = false,
  publishType = 'DEFAULT_PUBLISH',
  deployPercentage,
  skipReview = false,
  blockOnWarnings = false,
  apiBase = STORE_API,
  pollIntervalMs = 10_000,
  pollAttempts = 30,
  statusRetries = 2,
  requestTimeoutMs = 120_000,
  uploadTimeoutMs = 600_000,
  log = () => {},
  warn = () => {},
}: PublishOptions): Promise<PublishResult> {
  const item = `publishers/${publisherId}/items/${itemId}`;
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const call = storeClient({ token, apiBase, requestTimeoutMs, crxFileName });

  const fetchStatus = () => call<ItemStatus>('GET', `/v2/${item}:fetchStatus`);

  const status = await fetchStatus();
  const published = status.publishedItemRevisionStatus;
  const submitted = status.submittedItemRevisionStatus;
  const publishedVersions = versionsOf(published);
  const submittedVersions = versionsOf(submitted);
  log(`Store: published ${publishedVersions.join(', ') || 'none'}, submitted ${submittedVersions.join(', ') || 'none'}${submitted?.state ? ` (${submitted.state})` : ''}.`);
  if (status.takenDown === true) warn('The Chrome Web Store reports this item as taken down for a policy violation. A new version must fix the violation to pass review.');
  if (status.warned === true) warn('The Chrome Web Store reports a policy warning on this item. It will be taken down if the violation is not resolved.');

  if (publishedVersions.includes(version)) {
    const rollout = rolloutOf(published, version);
    if (deployPercentage !== undefined && rollout) return raisePublished(call, item, rollout, deployPercentage, dryRun, log);
    log(`Version ${version} is already published. Nothing to upload.`);
    return { result: 'skipped', state: published?.state ?? 'PUBLISHED' };
  }
  if (submittedVersions.includes(version)) {
    const submittedState = submitted?.state ?? 'unknown';
    if (SETTLED_STATES.has(submittedState)) {
      log(`Version ${version} is already ${submittedState}. Nothing to upload.`);
      return { result: 'skipped', state: submittedState };
    }
    throw new ActionError(
      `Version ${version} is ${submittedState} in the Chrome Web Store.`,
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

  async function waitWhileProcessing(first: { state: string | undefined; body: object }, label: string) {
    const started = Date.now();
    let state = first.state;
    let last: object = first.body;
    let failures = 0;
    for (let attempt = 1; UPLOADING_STATES.has(state ?? '') && attempt <= pollAttempts; attempt++) {
      log(`${label} is processing, checking again in ${pollIntervalMs / 1000} s.`);
      await sleep(pollIntervalMs);
      try {
        const next = await fetchStatus();
        last = next;
        failures = 0;
        state = next.lastAsyncUploadState;
      } catch (error) {
        failures += 1;
        if (!(error instanceof ActionError) || !error.retryable || failures > statusRetries) throw error;
        log(`Status check failed, trying again: ${error.message}`);
      }
    }
    return { state, last, seconds: Math.round((Date.now() - started) / 1000) };
  }

  if (UPLOADING_STATES.has(status.lastAsyncUploadState ?? '')) {
    if (dryRun) {
      log('An earlier upload is still processing in the store. A real run would wait for it before uploading.');
    } else {
      const earlier = await waitWhileProcessing({ state: status.lastAsyncUploadState, body: status }, 'An earlier upload');
      if (UPLOADING_STATES.has(earlier.state ?? '')) {
        throw new ActionError(
          `An earlier upload was still processing after ${earlier.seconds} s, so this run uploaded nothing.`,
          'Check the Developer Dashboard, then re-run this job once that upload has finished.',
        );
      }
    }
  }

  if (dryRun) {
    log(`Dry run: version ${version} would be uploaded${submit ? ' and submitted for review' : ' as a draft'}. Nothing was sent to the store.`);
    return { result: 'dry-run', state: '' };
  }

  const upload = await call<UploadResponse>('POST', `/upload/v2/${item}:upload`, {
    body: zip,
    headers: crxFileName ? { 'X-Goog-Upload-Protocol': 'raw', 'X-Goog-Upload-File-Name': crxFileName } : undefined,
    timeoutMs: uploadTimeoutMs,
    hint: crxFileName ? CRX_REFUSED_HINT : undefined,
  });
  if (upload.uploadState === 'SUCCEEDED' && typeof upload.crxVersion === 'string' && upload.crxVersion !== version) {
    throw new ActionError(
      `The store accepted a package with version ${upload.crxVersion}, not ${version}. This run did not submit it.`,
      'Another writer may have uploaded to this item at the same time. Check the draft in the Developer Dashboard.',
    );
  }
  const { state, last, seconds } = await waitWhileProcessing({ state: upload.uploadState, body: upload }, 'Upload');
  if (UPLOADING_STATES.has(state ?? '')) {
    throw new ActionError(
      `The store was still processing version ${version} after ${seconds} s. This run did not submit it.`,
      'The store may still finish processing it as a draft, or the upload may fail. Check the Developer Dashboard, then submit the draft there or re-run this job.',
    );
  }
  if (state !== 'SUCCEEDED') {
    const response = JSON.stringify(last).slice(0, 2000);
    const hint = crxFileName ? CRX_REFUSED_HINT : MUST_USE_CRX.test(response) ? USE_CRX_HINT : undefined;
    throw new ActionError(`Upload of version ${version} ended in state ${state ?? 'unknown'}.`, [`Store response: ${response}`, hint].filter(Boolean).join('\n'));
  }
  log(`Uploaded version ${version}.`);
  if (!submit) return { result: 'uploaded', state: '' };

  const publish = await call<PublishResponse>('POST', `/v2/${item}:publish`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publishType,
      ...(deployPercentage === undefined ? {} : { deployInfos: [{ deployPercentage }] }),
      ...(skipReview ? { skipReview: true } : {}),
      ...(blockOnWarnings ? { blockOnWarnings: true } : {}),
    }),
    hint: deployPercentage === undefined ? PUBLISH_HINT : `${PUBLISH_HINT} ${ROLLOUT_HINT}`,
  });
  log(`Submitted version ${version}${skipReview ? ' asking to skip review' : ' for review'}${deployPercentage === undefined ? '' : ` to ${deployPercentage}% of users`}. Store state: ${publish.state ?? 'unknown'}.`);
  const warnings = publish.warningInfo?.warnings;
  if (Array.isArray(warnings)) {
    for (const warning of warnings.slice(0, 20)) {
      const reason = typeof warning?.reason === 'string' ? ` ${warning.reason}` : '';
      const description = typeof warning?.description === 'string' ? warning.description : JSON.stringify(warning);
      warn(`Chrome Web Store warning${reason}: ${description}`.slice(0, 2000));
    }
  }

  let after: ItemStatus;
  try {
    after = await fetchStatus();
  } catch (error) {
    warn(`The submission went through, but reading the store status afterwards failed: ${(error as Error).message}`);
    return { result: 'submitted', state: publish.state ?? '' };
  }
  const inReview = versionsOf(after.submittedItemRevisionStatus);
  const reviewState = after.submittedItemRevisionStatus?.state;
  if (inReview.length > 0 && !inReview.includes(version) && REVIEW_STATES.has(reviewState ?? '')) {
    throw new ActionError(
      `The store has version ${inReview.join(', ')} in review, not ${version}. Another run replaced the uploaded package before this run submitted it.`,
      'Let one run publish at a time, for example with a concurrency group on the job, then release again.',
    );
  }
  return { result: 'submitted', state: (inReview.includes(version) && reviewState) || publish.state || '' };
}

function versionsOf(revision: RevisionStatus | undefined): string[] {
  return (revision?.distributionChannels ?? []).map((channel) => channel?.crxVersion).filter((version): version is string => typeof version === 'string');
}
