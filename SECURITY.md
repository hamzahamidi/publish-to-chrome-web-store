# Security

Report a vulnerability through [GitHub private vulnerability reporting](https://github.com/hamzahamidi/publish-to-chrome-web-store/security/advisories/new). Do not open a public issue for it.

Expect an acknowledgement within 7 days. A fix ships as a patch release of the latest major version, the major tag moves to it, and the advisory is published once the release is out.

The action sends credentials to `chromewebstore.googleapis.com` and, for the refresh token flow, `oauth2.googleapis.com`, and refuses redirects to anywhere else. It masks the access token, client ID, client secret, refresh token and any token it mints, returns none as an output and stores nothing. The README lists every request it makes.
