import { readFileSync, statSync } from 'node:fs';
import { ActionError } from './errors.mjs';
import { error, getBooleanInput, getInput, info, mask, setOutput, warning } from './runner.mjs';
import { publishToStore, STORE_API } from './store.mjs';
import { exchangeRefreshToken, TOKEN_ENDPOINT } from './token.mjs';
import { readManifest } from './zip.mjs';

const PUBLISH_TYPES = { default: 'DEFAULT_PUBLISH', staged: 'STAGED_PUBLISH' };
const ITEM_ID = /^[a-p]{32}$/;
const PUBLISHER_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER_SAFE = /^[\x21-\x7e]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MAX_PACKAGE_BYTES = 2 * 1024 ** 3;

async function main() {
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
  const zipPath = getInput('zip', { required: true });
  const submit = getBooleanInput('publish', true);
  const dryRun = getBooleanInput('dry-run', false);
  const publishTypeInput = getInput('publish-type').toLowerCase() || 'default';
  const publishType = PUBLISH_TYPES[publishTypeInput];

  if (!PUBLISHER_ID.test(publisherId)) throw new ActionError('Input publisher-id must contain only letters, digits, hyphens and underscores.');
  if (!ITEM_ID.test(itemId)) throw new ActionError('Input item-id must be the 32 letter extension ID shown in the Developer Dashboard.');
  if (!publishType) throw new ActionError(`Input publish-type must be default or staged, got ${JSON.stringify(publishTypeInput)}.`);

  const refreshInputs = { 'client-id': clientId, 'client-secret': clientSecret, 'refresh-token': refreshToken };
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
  if (accessToken && !HEADER_SAFE.test(accessToken)) {
    throw new ActionError('Input access-token contains spaces or control characters. Pass the access_token output of google-github-actions/auth, not a JSON key.');
  }

  let zip;
  try {
    const { size } = statSync(zipPath);
    if (size > MAX_PACKAGE_BYTES) throw new ActionError(`${JSON.stringify(zipPath)} is larger than 2 GB, the largest package the Chrome Web Store accepts.`);
    zip = readFileSync(zipPath);
  } catch (cause) {
    if (cause instanceof ActionError) throw cause;
    throw new ActionError(`Cannot read ${JSON.stringify(zipPath)}: ${cause.code === 'ENOENT' ? 'no such file' : cause.message}.`);
  }
  const { version } = readManifest(zip, JSON.stringify(zipPath));

  let token = accessToken;
  if (!token) {
    token = await exchangeRefreshToken({ clientId, clientSecret, refreshToken, endpoint: tokenEndpoint });
    mask(token);
    if (!HEADER_SAFE.test(token)) throw new ActionError('Google returned an access token that is not a valid HTTP header value.');
  }

  info(`The ZIP holds version ${version}.`);
  setOutput('version', version);

  const { result, state } = await publishToStore({
    token,
    publisherId,
    itemId,
    version,
    zip,
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

function testEndpoint(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  let url;
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

main().catch((cause) => {
  if (cause instanceof ActionError) error(cause.details ? `${cause.message}\n${cause.details}` : cause.message);
  else error(`Unexpected failure: ${cause?.stack ?? cause}`);
  process.exitCode = 1;
});
