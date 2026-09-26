# Publish to Chrome Web Store

A GitHub Action that publishes a Chrome extension from GitHub Actions: it uploads the ZIP, or a signed CRX, to the Chrome Web Store and submits it for review, through the Chrome Web Store API v2.

- **No stored secret needed.** It takes a short-lived access token, which `google-github-actions/auth` can mint through Workload Identity Federation. The store credential never sits in your repository secrets. Verified CRX Uploads, if you opt in, add one secret: the signing key.
- **Safe to re-run.** It reads the store status before writing anything. A version that is already published or in review is skipped. A version that the store would refuse, or a review in progress for another version, stops the run with a clear message before anything is uploaded.
- **Approval before each upload.** The recommended setup only lets an approved job in one GitHub environment obtain the token.
- **Readable, typed, no runtime dependencies.** About 900 lines of TypeScript in `src/` and `sign/`, importing only Node.js built-ins. Node runs those files as they are: no bundle, no `dist/`, no build step, so what you read is what runs.
- **Verified CRX Uploads, if you opt in.** A companion `sign` action signs the ZIP as a CRX3 in a separate job, writing for the same ZIP the same bytes as Chrome's packer, and this action uploads it. The signing key and the store token never meet in one job.
- **Partial rollouts.** `deploy-percentage` releases a version to a share of users and raises that share later, for items large enough that Google allows it.
- **Testable without risk.** `dry-run: true` checks your ZIP, that your credentials can read the item, and the store state, then stops before uploading.
- **Existing setups work too.** It also accepts an OAuth client ID, client secret and refresh token.

The Chrome Web Store API v1.1 stops working on 15 October 2026. This action only calls v2.

Not affiliated with or endorsed by Google. Chrome Web Store is a trademark of Google LLC.

## Before you start

- The extension must already exist in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole): uploading the first ZIP there creates the item and its ID. The API cannot create an item. Before the first publish, Google requires the Store listing and Privacy tabs to be filled out.
- Google requires 2-step verification on the account that owns the publisher.
- Every release needs a `version` in `manifest.json` higher than the published one. The action stops before uploading when it is not.
- The ZIP holds the contents of your extension folder, with `manifest.json` at its root, not the folder itself.
- One writer per item. The API submits whichever package was uploaded last and has no way to submit a specific one, so nothing else should upload to the same item while a run is going: not the dashboard, not another workflow. The action detects a competing upload, but only after the fact.

## Usage

### With Workload Identity Federation (recommended)

```yaml
on:
  push:
    tags: ['v*']

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      # ... build your extension into dist/ ...
      - run: cd dist && zip -qr ../extension.zip .
      - uses: actions/upload-artifact@v7
        with:
          name: extension
          path: extension.zip

  publish:
    needs: build
    runs-on: ubuntu-latest
    environment: chrome-web-store
    permissions:
      id-token: write
    concurrency:
      group: chrome-web-store
      cancel-in-progress: false
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - id: auth
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: ${{ vars.CWS_WIF_PROVIDER }}
          service_account: ${{ vars.CWS_SERVICE_ACCOUNT }}
          token_format: access_token
          access_token_scopes: https://www.googleapis.com/auth/chromewebstore
          access_token_lifetime: 1800s
          create_credentials_file: false
          export_environment_variables: false
      - uses: hamzahamidi/publish-to-chrome-web-store@v1
        with:
          access-token: ${{ steps.auth.outputs.access_token }}
          publisher-id: your-publisher-id
          item-id: abcdefghijklmnopabcdefghijklmnop
          zip: extension.zip
```

The build runs in its own job, so your build tools and their dependencies never run next to the store token. The publish job only downloads the ZIP, gets the token and runs this action. It waits for approval in the `chrome-web-store` environment, and the concurrency group keeps two releases from uploading at the same time.

The one-time Google Cloud setup is described in [Setting up Workload Identity Federation](#setting-up-workload-identity-federation). With the provider it creates, every run must come from a tag. A run from a branch fails in the `google-github-actions/auth` step, before this action starts, with "The given credential is rejected by the attribute condition".

### With Verified CRX Uploads (optional)

[Verified CRX Uploads](https://developer.chrome.com/docs/webstore/update#opt-in-to-verified-crx-uploads) make the store accept only packages signed with your own RSA key, so a leaked store token alone cannot publish. It is per item and optional; without it, keep using `zip`.

The `crx` upload sends the headers Google documents, and `sign` matches Chrome's packer byte for byte for the same ZIP. After opting in, the dashboard still accepts a manual upload of the same CRX.

1. Create the key pair and register the public half. Google's page shows `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out privatekey.pem` and `openssl rsa -in privatekey.pem -pubout`. On the item's Package tab, click Opt In under Verified CRX Uploads and paste the public key.
2. Create an environment named `crx-signing` with a deployment rule that only allows your release tags, and a required reviewer where your plan allows one. Store the whole unencrypted `privatekey.pem`, BEGIN and END lines included, as its environment secret: `gh secret set CRX_PRIVATE_KEY --env crx-signing --repo OWNER/REPO < privatekey.pem`. Use an environment secret rather than a repository secret, because anyone with write access can read repository secrets from any branch. Keep it out of `chrome-web-store`: the provider condition only issues the store token to that environment, so a job in `crx-signing` can never get it.
3. Decide on a backup. GitHub never shows a secret again. If the key is lost, no update can be uploaded until Chrome Web Store support registers a new one, which Google says can take up to one week, so keep one copy in a password manager unless you accept that wait. Delete any other copies.
4. Sign in its own job, then upload the CRX:

```yaml
  sign:
    needs: build
    runs-on: ubuntu-latest
    environment: crx-signing
    permissions: {}
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension
      - id: sign
        uses: hamzahamidi/publish-to-chrome-web-store/sign@v1
        with:
          zip: extension.zip
          private-key: ${{ secrets.CRX_PRIVATE_KEY }}
      - uses: actions/upload-artifact@v7
        with:
          name: extension-crx
          path: ${{ steps.sign.outputs.crx }}
```

In the publish job, change `needs: build` to `needs: sign`, download `extension-crx` instead of `extension`, and pass `crx` instead of `zip`:

```yaml
  publish:
    needs: sign
    # runs-on, environment, permissions and concurrency as above
    steps:
      - uses: actions/download-artifact@v8
        with:
          name: extension-crx
      # the auth step as above
      - uses: hamzahamidi/publish-to-chrome-web-store@v1
        with:
          access-token: ${{ steps.auth.outputs.access_token }}
          publisher-id: your-publisher-id
          item-id: abcdefghijklmnopabcdefghijklmnop
          crx: extension.crx
```

`sign` accepts an unencrypted PKCS#8 or PKCS#1 PEM. Export a passphrase-protected key first with `openssl pkey -in encrypted.pem -out privatekey.pem`. It writes a CRX3 with one RSA proof, the format Chrome's `--pack-extension` writes, and a CI job compares the two byte for byte on every change. It never uploads anything.

### Trying it first

Add `dry-run: true` to the publish step of any setup above (the `sign` action has no such input). The run reads the ZIP, or the ZIP inside the CRX, obtains the token, fetches the item status and prints what a real run would do. It sends nothing to the store except that status request. To start a dry run by hand, give the workflow a `workflow_dispatch` trigger and pick a tag under "Use workflow from".

The status request also accepts a read-only token, so a dry run proves that the credentials can read the item. Write access is first used by the upload, and the store checks a CRX signature only then.

### Partial rollout

Google lets the API set a rollout percentage only for items with more than 10,000 seven-day active users, and the percentage can only go up. For a smaller item the store refuses the request, and the action shows Google's message with that rule.

To submit a version to 10% of users, add the input to the publish step:

```yaml
- uses: hamzahamidi/publish-to-chrome-web-store@v1
  with:
    access-token: ${{ steps.auth.outputs.access_token }}
    publisher-id: your-publisher-id
    item-id: your-32-letter-extension-id
    zip: extension.zip
    deploy-percentage: 10
```

To raise the published version to 50% later, run the step again with the ZIP of that version and `deploy-percentage: 50`. The action sees the version is published and raises it instead of skipping it. Without a package, set `rollout-only: true` and leave out `zip` and `crx`: the action reads which version is published and raises it.

```yaml
- uses: hamzahamidi/publish-to-chrome-web-store@v1
  with:
    access-token: ${{ steps.auth.outputs.access_token }}
    publisher-id: your-publisher-id
    item-id: your-32-letter-extension-id
    rollout-only: true
    deploy-percentage: 50
```

`rollout-only` is a separate input so that an empty `zip`, such as a mistyped step output, fails the run instead of turning a release into a rollout change. When the store already reports the percentage or more, nothing is sent and `result` is `skipped`, so a re-run is safe. `dry-run: true` reports the change without sending it.

`skip-review: true` asks the store to publish without review. The store refuses the submission when the change needs review, and the run fails with the package left as a draft, so drop the input for such a release. `block-on-warnings: true` makes the store refuse the submission when it has warnings, and the action shows the warnings the store returns.

`deploy-percentage`, `skip-review` and `block-on-warnings` only apply when the store publishes, so the action refuses them with `publish: false`.

### With an OAuth refresh token

```yaml
      - uses: hamzahamidi/publish-to-chrome-web-store@v1
        with:
          client-id: ${{ secrets.CWS_CLIENT_ID }}
          client-secret: ${{ secrets.CWS_CLIENT_SECRET }}
          refresh-token: ${{ secrets.CWS_REFRESH_TOKEN }}
          publisher-id: your-publisher-id
          item-id: abcdefghijklmnopabcdefghijklmnop
          zip: extension.zip
```

Google's guide [Use the Chrome Web Store API](https://developer.chrome.com/docs/webstore/using-api) shows how to create the OAuth client and obtain a refresh token. Refresh tokens of an OAuth app whose consent screen is in Testing status expire after 7 days. The action says so when Google refuses the token.

A service account key also works. Grant the service account `roles/iam.serviceAccountTokenCreator` on itself, then pass the key to `google-github-actions/auth` as `credentials_json` in place of `workload_identity_provider`, keeping `service_account`, `token_format` and `access_token_scopes`. A key is a long-lived secret, so prefer federation.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `access-token` | one of the two credential forms | | Access token with the `https://www.googleapis.com/auth/chromewebstore` scope |
| `client-id`, `client-secret`, `refresh-token` | one of the two credential forms | | OAuth client and refresh token, exchanged for an access token at the start of the run |
| `publisher-id` | yes | | Publisher ID from the Account page of the Developer Dashboard |
| `item-id` | yes | | The 32 letter extension ID |
| `zip` | one of `zip` or `crx`, unless `rollout-only` | | Path to the extension ZIP, with `manifest.json` at its root |
| `crx` | one of `zip` or `crx`, unless `rollout-only` | | Path to a CRX3 you signed, for an item opted in to Verified CRX Uploads. Uploaded as is |
| `publish` | no | `true` | `false` uploads the package as a draft without submitting it |
| `dry-run` | no | `false` | `true` stops after the status check and reports what would happen |
| `deploy-percentage` | no | | Share of users, 0 to 100, who get the version. Needs `publish: true`. See [Partial rollout](#partial-rollout) |
| `rollout-only` | no | `false` | `true`, with `deploy-percentage` and no `zip` or `crx`, raises the rollout of the newest published version without uploading. It cannot be combined with `skip-review`, `block-on-warnings` or `publish-type: staged` |
| `skip-review` | no | `false` | `true` asks the store to publish without review. The store refuses the submission when the change needs review. Needs `publish: true` |
| `block-on-warnings` | no | `false` | `true` makes the store refuse the submission when it has warnings. Needs `publish: true` |
| `publish-type` | no | `default` | `default` makes the version live once it passes review. `staged` holds the approved version until you publish it in the dashboard or with a separate publish call to the API. You have 30 days after approval, then it reverts to a draft and needs a new review. This action does not publish a staged version, even when re-run |

## Outputs

| Output | Description |
| --- | --- |
| `result` | `submitted`, `uploaded` (when `publish` is `false`), `skipped` (this version was already in the store, or its rollout already reached `deploy-percentage`), `raised` (the rollout of the published version went up) or `dry-run` (a dry run that would upload or raise) |
| `state` | Store state of this version at the end, such as `PENDING_REVIEW`, `STAGED` or `PUBLISHED`. Empty when `result` is `uploaded`, or `dry-run` for an upload, or when the store reports no state after submitting |
| `version` | The version read from `manifest.json` in the ZIP, or with `rollout-only` the newest published version |

## What it does

1. Reads `manifest.json` from the ZIP, or from the ZIP inside the CRX, and checks the version, before any network call. A ZIP whose manifest sits in a subfolder is refused with a hint. A CRX passed as `zip` is pointed to `crx`, and a CRX2 or differential CRX is refused.
2. Fetches the item status and decides:

   | Store state | What the action does |
   | --- | --- |
   | This version is published and `deploy-percentage` is higher than its rollout | Raises the rollout and stops. `result` is `raised` |
   | This version is published, in review, approved or published to testers | Nothing. `result` is `skipped` and the step succeeds |
   | This version was rejected or its review was cancelled | Fails. Resubmit it from the dashboard or release a new version |
   | The published version is equal or higher | Fails without uploading, because the store only accepts a higher version |
   | Another version is in review | Fails without uploading, because the store refuses new packages during a review |
   | Another version is approved but not published | Fails and asks you to publish or cancel it in the dashboard |
   | Anything else | Continues |

   A taken down item or one with a policy warning gets a warning in the log, and the run continues.

3. Stops here on a dry run.
4. Waits first if an earlier upload is still processing. Then uploads the package, the ZIP or the CRX as is, stops if the store reports a different version for it, and checks the status every 10 seconds, up to 30 times, while the store processes it. A check that fails with a network error or HTTP 429, 500, 502, 503 or 504 counts as one of the 30, and three such failures in a row end the run. If processing takes longer, the run fails without submitting. The store may still finish the package as a draft, or the upload may fail, so check the dashboard before re-running.
5. Submits the version for review, unless `publish` is `false`, with `deploy-percentage`, `skip-review` and `block-on-warnings` when given. Warnings the store returns appear as warning annotations.
6. Reads the status once more. If a different version is now in review, another writer replaced the package before this run submitted it. The run fails to report that, but the other package is already submitted.

With `rollout-only`, the action only fetches the status and raises the rollout of the newest published version to `deploy-percentage`.

Store errors are reported with the HTTP status, the store's message and a hint for the common causes.

## How it compares

Checked on 26 September 2026 from each repository's `action.yml`, `package.json` and upload code.

| Action | Store API | Credentials it accepts | Signed CRX upload | Runtime packages | What the runner executes |
| --- | --- | --- | --- | --- | --- |
| This action | v2 | Access token (for example from Workload Identity Federation), or OAuth refresh token | Yes, plus a `sign` action | None | The TypeScript source in `src/` |
| [mnao305/chrome-extension-upload](https://github.com/mnao305/chrome-extension-upload) | v2 | OAuth refresh token | No: every upload is labeled as a ZIP | 3 | A bundled `dist/index.js` |
| [wdzeng/chrome-extension](https://github.com/wdzeng/chrome-extension) | v2 | OAuth refresh token | No | 3 | A bundled `index.cjs` |
| [cssnr/webstore-publish-action](https://github.com/cssnr/webstore-publish-action) | v2 | Bearer token, or a service account key | No | 5 | A bundled `dist/index.js` |
| [PlasmoHQ/bpp](https://github.com/PlasmoHQ/bpp) | v1.1, which stops on 15 October 2026 | OAuth refresh token | No | None, bundled | `index.js`, declared for Node 20 |

## Setting up Workload Identity Federation

You need the Google account that owns the Chrome Web Store publisher. The `gcloud` commands run in [Cloud Shell](https://shell.cloud.google.com) or anywhere `gcloud` is signed in. The `gh` commands need the [GitHub CLI](https://cli.github.com) signed in to an account with admin access to the repository. The resources below were created on a project with no billing account.

**1. Find the numeric IDs of your repository and its owner.** Numeric IDs keep working when the repository is renamed, and a different repository created later under the same name cannot use them.

```bash
gh api repos/OWNER/REPO --jq '"owner \(.owner.id), repository \(.id)"'
```

**2. Create a project and turn on the four APIs involved:** Chrome Web Store, IAM, IAM Service Account Credentials and Security Token Service.

```bash
PROJECT_ID=my-extension-publish
gcloud projects create "$PROJECT_ID"
gcloud config set project "$PROJECT_ID"
gcloud services enable chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com
```

**3. Create the service account.** It gets no project roles. Its only power comes from being linked to the publisher in step 6.

```bash
gcloud iam service-accounts create cws-publisher --display-name="Chrome Web Store publisher"
```

**4. Create an identity pool and a GitHub provider.** The provider accepts a GitHub token only from a tag run of your repository, by owner ID and repository ID, in a job that uses the `chrome-web-store` environment. Any other workflow or branch in the repository is refused.

```bash
OWNER_ID=12345678
REPO_ID=987654321
gcloud iam workload-identity-pools create cws-publish --location=global --display-name="Chrome Web Store publishing"
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=cws-publish \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref_type=assertion.ref_type" \
  --attribute-condition="assertion.repository_owner_id == '$OWNER_ID' && assertion.repository_id == '$REPO_ID' && assertion.ref_type == 'tag' && assertion.environment == 'chrome-web-store'"
```

**5. Let that repository act as the service account.** This grants `roles/iam.workloadIdentityUser` on the `cws-publisher` account only, not on the project, to tokens the pool accepted for your repository ID. The last two lines print the values for step 7.

```bash
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "cws-publisher@$PROJECT_ID.iam.gserviceaccount.com" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/cws-publish/attribute.repository_id/$REPO_ID"
echo "CWS_WIF_PROVIDER=projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/cws-publish/providers/github"
echo "CWS_SERVICE_ACCOUNT=cws-publisher@$PROJECT_ID.iam.gserviceaccount.com"
```

**6. Link the service account to the publisher.** In the Developer Dashboard, open Account and add the service account email in the service account section. A publisher can link one service account.

**7. Store the two printed values as repository variables.** They are identifiers, not secrets. In the web UI this is Settings, Secrets and variables, Actions, Variables.

```bash
gh variable set CWS_WIF_PROVIDER --repo OWNER/REPO --body "projects/..."
gh variable set CWS_SERVICE_ACCOUNT --repo OWNER/REPO --body "cws-publisher@..."
```

**8. Create the environment.** In the repository settings, add an environment named `chrome-web-store` with yourself as a required reviewer and a deployment rule that only allows your release tags, such as `v*`.

A tag ruleset that limits who can create release tags narrows it further.

### Repositories without environments

Environments on private repositories depend on your GitHub plan. Without one, drop `&& assertion.environment == 'chrome-web-store'` from the condition in step 4 and `environment: chrome-web-store` from the job. Then anyone who can push a tag to the repository can publish, so limit who can create tags with a ruleset.

### Publishing from a branch

If you release from a branch instead of tags, replace `assertion.ref_type == 'tag'` with `assertion.ref == 'refs/heads/main' && assertion.event_name == 'push'`, using your release branch. Do not remove the ref check: without it, every workflow in the repository can publish, including runs triggered by pull requests.

## Trust and security

### Every request the action makes

| When | Request |
| --- | --- |
| Refresh token flow only | `POST https://oauth2.googleapis.com/token` with the client ID, client secret and refresh token |
| Always | `GET https://chromewebstore.googleapis.com/v2/publishers/{publisher-id}/items/{item-id}:fetchStatus` |
| Unless skipped, refused, raised or a dry run | `POST https://chromewebstore.googleapis.com/upload/v2/publishers/{publisher-id}/items/{item-id}:upload` with the ZIP, or with the CRX plus the `X-Goog-Upload-Protocol: raw` and `X-Goog-Upload-File-Name` headers Google documents for it |
| While an earlier upload or this one is processing | `GET ...:fetchStatus` again, every 10 seconds, up to 30 times |
| After a successful upload, unless `publish` is `false` | `POST https://chromewebstore.googleapis.com/v2/publishers/{publisher-id}/items/{item-id}:publish` with `{"publishType": ...}`, plus `deployInfos`, `skipReview` and `blockOnWarnings` when their inputs are set |
| When `deploy-percentage` raises a published version, with a ZIP or CRX of that version or with `rollout-only`, unless a dry run | `POST https://chromewebstore.googleapis.com/v2/publishers/{publisher-id}/items/{item-id}:setPublishedDeployPercentage` with `{"deployPercentage": ...}` |
| After submitting | `GET ...:fetchStatus` once, to confirm which version is in review |

The hosts are fixed in the code. There is no input to change them, redirects are refused rather than followed, and the test settings described under [Development](#development) only accept loopback addresses. `publisher-id` and `item-id` are validated before they are placed in a URL.

### What it does not do

- It does not print credentials. `access-token`, `client-id`, `client-secret` and `refresh-token` are masked before the first log line, and a token minted from a refresh token is masked as soon as Google returns it, also before the first log line.
- It does not return credentials. The outputs are `result`, `state` and `version`.
- It writes no file other than its step outputs, starts no process and sends no telemetry.
- It has no runtime dependencies. TypeScript and `@types/node` are development dependencies that type-check the code in CI; the runner never installs them.

### The code

| File | Lines | Role |
| --- | --- | --- |
| [`src/main.ts`](src/main.ts) | ~160 | Reads and validates inputs, masks secrets, sets outputs |
| [`src/store.ts`](src/store.ts) | ~400 | The store calls, their response types and the state decisions |
| [`src/zip.ts`](src/zip.ts) | ~130 | Reads `manifest.json` from the ZIP, with checksum verification |
| [`src/token.ts`](src/token.ts) | ~50 | Refresh token exchange |
| [`src/runner.ts`](src/runner.ts) | ~50 | GitHub Actions inputs, outputs, masking and annotations |
| [`src/errors.ts`](src/errors.ts) | ~20 | The error type for failures shown as an error annotation, and network error wording |
| [`src/crx.ts`](src/crx.ts) | ~30 | Finds the ZIP inside a CRX3, refusing CRX2 and damaged headers |
| [`src/sign.ts`](src/sign.ts), [`sign/main.ts`](sign/main.ts) | ~50, ~50 | The `sign` action: CRX3 signing with one RSA proof |

### How it is checked

- Every pull request type-checks the code and runs the tests on Linux, Windows and macOS with a coverage floor of 95% of lines. The tests start the action's entry point against a mock store on all three, and a separate job runs the action from `action.yml`. See [ci.yml](.github/workflows/ci.yml).
- [CodeQL](.github/workflows/codeql.yml) scans the JavaScript and the workflows on every pull request, every push to `main` and weekly. Dependabot keeps the workflow actions current.
- Releases are immutable: once `v1.0.0` is published, its tag and contents cannot change. `v1` points at the newest `1.x` release. [The workflow that moves it](.github/workflows/major-tag.yml) always points `v1` at the highest `1.x.y` release, refuses one that is not immutable, and runs one release at a time. If your organization requires full commit SHAs, pin the commit of a release.

### Your side

The linked service account can manage every item of the publisher. Bind only repositories you control, and keep the environment in the provider condition.

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Limits

What this action does not do:

- It does not publish a staged version or cancel a pending review. Do both in the dashboard.
- It refuses ZIP64 archives, and gives the upload request 10 minutes to finish.

What the Chrome Web Store imposes on any publishing tool:

- The API cannot create an item or change its visibility. After you change visibility in the dashboard, publish once by hand with the new visibility: until then the API cannot publish ([Google's note](https://developer.chrome.com/docs/webstore/using-api)).
- One service account per publisher, shared by all its extensions.
- Packages up to 2 GB.
- A rollout percentage can only be set for items with more than 10,000 seven-day active users, and only upward. The API has no call to lower it.

## FAQ

### Do I need Google Cloud?

Yes, a Google Cloud project, whichever credential you use. Google only issues Chrome Web Store API tokens to an OAuth client or a service account, and both belong to a project with the Chrome Web Store API enabled. The project runs nothing: it only holds that identity. The setup in this README was created on a project with no billing account.

The refresh token route skips the service account and Workload Identity Federation, but still needs an OAuth client in a project, and it puts a long-lived secret in your repository.

### Does it store a secret?

Not with Workload Identity Federation. Each run exchanges GitHub's OIDC token for an access token that lasts 30 minutes. The only values stored in the repository are two identifiers. If you opt in to Verified CRX Uploads, the RSA signing key is also stored, as an environment secret that only the `sign` job reads; on its own it cannot publish.

### Is it safe to re-run a release?

Yes, when only one writer uploads to the item. A version already published or in review is skipped, and a version the store would refuse stops the run before anything is uploaded.

### Can I try it without publishing?

Yes. `dry-run: true` reads the ZIP, obtains the token and fetches the item status, then stops.

### Does it work with private repositories and other operating systems?

Yes. Private repositories work; only the approval environment depends on your GitHub plan. The tests run the action on Linux, Windows and macOS runners.

### Can I use Verified CRX Uploads?

Yes, optionally. Opt the item in on its Package tab, sign with the `sign` action in its own environment, and pass the CRX through `crx`. See [With Verified CRX Uploads](#with-verified-crx-uploads-optional).

### Is it made by Google?

No. It is an independent open source project and calls Google's public API.

## Development

Node.js 24 or later:

```bash
npm ci
npm run typecheck
npm test
```

The tests run the action against a local mock of the store API. `CWS_API_BASE` and `CWS_TOKEN_ENDPOINT` point the action at that mock, and it refuses them unless they are loopback `http` addresses.

## License

[MIT](LICENSE)
