# Changelog

## 1.0.0

First release.

- Uploads a ZIP to the Chrome Web Store API v2 and submits it for review, or uploads a draft with `publish: false`.
- Accepts an access token, such as one minted through Workload Identity Federation, or an OAuth client ID, client secret and refresh token.
- Reads the store status first: skips a version already in the store, and stops before uploading when the version is not higher than the published one, while another version is in review, or while one waits to be published.
- `dry-run: true` checks the ZIP, that the credentials can read the item, and the store state, without uploading.
- `publish-type: staged` keeps an approved version waiting up to 30 days for you to publish it in the dashboard or through the API.
- Waits for an earlier upload that is still processing, refuses to submit when the store reports another version for the uploaded package, and reads the status again after submitting to detect a competing writer.
- Refuses packages over 2 GB before reading them.
- Masks every credential input and any minted token before the first log line, and refuses redirects so credentials only reach Google's two hosts.
