# Changelog

## 1.2.1

- The Marketplace description and the README opening lead with publishing through a short-lived token, and the README starts with a quick start and a short comparison. Documentation only: the code is unchanged.

## 1.2.0

- `deploy-percentage` submits a version to a share of users. With the package of a version already published, or with `rollout-only: true` and no package, it raises the published rollout through `setPublishedDeployPercentage`. A rollout that already reaches the percentage is skipped, so re-runs are safe. Google allows this only for items with more than 10,000 seven-day active users, and only upward.
- `skip-review` asks the store to publish without review, which it refuses when the change needs review, and `block-on-warnings` makes it refuse a submission that has warnings.
- The three inputs need `publish: true`, and `rollout-only` refuses a package, `skip-review`, `block-on-warnings` and `publish-type: staged`, so a misconfigured run stops before any request.
- A new `result`, `raised`, reports a rollout that went up.
- Store errors include the details Google returns beyond the error reason, such as the warnings that blocked a submission.

## 1.1.0

- Optional support for Verified CRX Uploads. The new `crx` input uploads a CRX3 with the `X-Goog-Upload-Protocol: raw` and `X-Goog-Upload-File-Name` headers Google documents, and reads the version from the ZIP inside it. `zip` works as before.
- A companion action, `hamzahamidi/publish-to-chrome-web-store/sign@v1`, signs a ZIP as a CRX3 with an RSA key, writing the same bytes Chrome's `--pack-extension` writes around the same ZIP. It is meant for a job in its own environment that holds no store token.
- A ZIP refused with `PKG_MUST_UPDATE_AS_CRX` now points to the `crx` input, and a refused CRX points to the opt-in and the registered key.

## 1.0.0

First release.

- Uploads a ZIP to the Chrome Web Store API v2 and submits it for review, or uploads a draft with `publish: false`.
- Accepts an access token, such as one minted through Workload Identity Federation, or an OAuth client ID, client secret and refresh token.
- Reads the store status first: skips a version already in the store, and stops before uploading when the version is not higher than the published one, while another version is in review, or while one waits to be published.
- `dry-run: true` checks the ZIP, that the credentials can read the item, and the store state, without uploading.
- `publish-type: staged` keeps an approved version waiting up to 30 days for you to publish it in the dashboard or through the API.
- Waits for an earlier upload that is still processing, refuses to submit when the store reports another version for the uploaded package, and reads the status again after submitting to detect a competing writer.
- Refuses packages over 2 GB before reading them.
- Written in TypeScript that Node 24 runs directly, with no bundle and no runtime dependencies.
- Masks every credential input and any minted token before the first log line, and refuses redirects so credentials only reach Google's two hosts.
