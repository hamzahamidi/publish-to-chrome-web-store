import { ActionError, networkReason } from './errors.mjs';

export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export async function exchangeRefreshToken({ clientId, clientSecret, refreshToken, endpoint = TOKEN_ENDPOINT, timeoutMs = 60_000 }) {
  let response;
  let text;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ActionError(`The Google token endpoint answered with a redirect (HTTP ${response.status}), which the action refuses to follow.`);
    }
    text = await response.text();
  } catch (error) {
    if (error instanceof ActionError) throw error;
    throw new ActionError(`Exchanging the refresh token failed: ${networkReason(error)}`);
  }
  let body = {};
  try {
    body = JSON.parse(text) ?? {};
  } catch {
    body = {};
  }
  if (response.ok && typeof body.access_token === 'string') return body.access_token;
  if (response.ok) throw new ActionError('Google answered the refresh token request without an access token.');

  const reason = [body.error, body.error_description].filter((part) => typeof part === 'string').join(': ') || `HTTP ${response.status}`;
  throw new ActionError(
    `Google refused the refresh token with ${reason.replace(/\.?$/, '.')}`,
    body.error === 'invalid_grant'
      ? 'Refresh tokens of an OAuth app in Testing status expire after 7 days. Mint a new one, or switch to an access token from Workload Identity Federation.'
      : undefined,
  );
}
