import { readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { crxArchive, isCrx } from './crx.ts';
import { ActionError } from './errors.ts';
import { error, getBooleanInput, getInput, info, mask, setOutput, warning } from './runner.ts';
import { type PublishType, publishToStore, STORE_API } from './store.ts';
import { exchangeRefreshToken, TOKEN_ENDPOINT } from './token.ts';
import { readManifest } from './zip.ts';

const PUBLISH_TYPES: Record<string, PublishType> = { default: 'DEFAULT_PUBLISH', staged: 'STAGED_PUBLISH' };
const ITEM_ID = /^[a-p]{32}$/;
const PUBLISHER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;

async function main(): Promise<void> {
  const accessToken = getInput('access-token');
  const clientId = getInput('client-id');
  const clientSecret = getInput('client-secret');
  const refreshToken = getInput('refresh-token');
  mask(accessToken);
  mask(clientId);
  mask(clientSecret);
  mask(refreshToken);

  const apiBase = testEndpoint('CWS_API_BASE', STORE_API);
  const tokenEndpoint = testEndpoint('CWS_TOKEN_ENDPOINT', TOKEN_ENDPOINT);
  const publisherId = getInput('publisher-id', { required: true });
  const itemId = getInput('item-id', { required: true });
  const zipPath = getInput('zip');
  const crxPath = getInput('crx');
  const submit = getBooleanInput('publish', true);
  const dryRun = getBooleanInput('dry-run', false);
  const publishTypeInput = getInput('publish-type').toLowerCase() || 'default';
  const publishType = PUBLISH_TYPES[publishTypeInput];

  if (!PUBLISHER_ID.test(publisherId)) throw new ActionError('Input publisher-id must contain only letters, digits, hyphens and underscores.');
  if (!ITEM_ID.test(itemId)) throw new ActionError('Input item-id must be the 32 letter extension ID shown in the Developer Dashboard.');
  if (!publishType) throw new ActionError(`Input publish-type must be default or staged, got ${JSON.stringify(publishTypeInput)}.`);

  const refreshInputs: Record<string, string> = { 'client-id': clientId, 'client-secret': clientSecret, 'refresh-token': refreshToken };
  const given = Object.keys(refreshInputs).filter((name) => refreshInputs[name]);
  if (accessToken && given.length > 0) {
    throw new ActionError(`Pass either access-token or the client-id, client-secret and refresh-token trio, not both (got access-token and ${given.join(', ')}).`);
  }
  if (!accessToken && given.length < 3) {
    const missing = Object.keys(refreshInputs).filter((name) => !refreshInputs[name]);
    throw new ActionError(
      given.length === 0
        ? 'No credentials. Pass access-token, or client-id, client-secret and refresh-token.'
        : `Missing ${missing.join(', ')}. The refresh token flow needs client-id, client-secret and refresh-token.`,
    );
  }
  if (zipPath && crxPath) throw new ActionError('Pass either zip or crx, not both.');
  if (!zipPath && !crxPath) throw new ActionError('Input zip is required, or crx for an item opted in to Verified CRX Uploads.');
  if (accessToken && !HEADER_SAFE.test(accessToken)) {
    throw new ActionError('Input access-token contains spaces or control characters. Pass the access_token output of google-github-actions/auth, not a JSON key.');
  }

  const packagePath = crxPath || zipPath;
  const label = JSON.stringify(packagePath);
  let packageFile: Buffer;
  try {
    const { size } = statSync(packagePath);
    if (size > MAX_PACKAGE_BYTES) throw new ActionError(`${label} is larger than 2 GB, the largest package the Chrome Web Store accepts.`);
    packageFile = readFileSync(packagePath);
  } catch (cause) {
    if (cause instanceof ActionError) throw cause;
    const { code, message } = cause as NodeJS.ErrnoException;
    throw new ActionError(`Cannot read ${label}: ${code === 'ENOENT' ? 'no such file' : message}.`);
  }
  if (!crxPath && isCrx(packageFile)) throw new ActionError(`${label} is a CRX package, not a ZIP. Pass a signed CRX through the crx input instead.`);
  const { version } = readManifest(crxPath ? crxArchive(packageFile, label) : packageFile, label);
  const crxFileName = crxPath ? crxUploadName(crxPath) : undefined;

  let token = accessToken;
  if (!token) {
    token = await exchangeRefreshToken({ clientId, clientSecret, refreshToken, endpoint: tokenEndpoint });
    mask(token);
    if (!HEADER_SAFE.test(token)) throw new ActionError('Google returned an access token that is not a valid HTTP header value.');
  }

  info(`The ${crxPath ? 'CRX' : 'ZIP'} holds version ${version}.`);
  setOutput('version', version);

  const { result, state } = await publishToStore({
    token,
    publisherId,
    itemId,
    version,
    zip: packageFile,
    crxFileName,
    submit,
    dryRun,
    publishType,
    apiBase,
    log: info,
    warn: warning,
  });
  setOutput('result', result);
  setOutput('state', state);
}

function crxUploadName(path: string): string {
  const name = basename(path).replace(/[^A-Za-z0-9._-]/g, '_');
  return name.toLowerCase().endsWith('.crx') ? name : `${name}.crx`;
}

function testEndpoint(name: string, fallback: string): string {
  const value = process.env[name];
  if (!value) return fallback;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ActionError(`${name} is not a URL.`);
  }
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new ActionError(`${name} is a test setting and may only point to http://127.0.0.1, http://localhost or http://[::1].`);
  }
  return value.replace(/\/+$/, '');
}

main().catch((cause: unknown) => {
  if (cause instanceof ActionError) error(cause.details ? `${cause.message}\n${cause.details}` : cause.message);
  else error(`Unexpected failure: ${(cause as Error | undefined)?.stack ?? cause}`);
  process.exitCode = 1;
});
