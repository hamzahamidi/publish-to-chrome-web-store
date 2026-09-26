# Publish to Chrome Web Store

A GitHub Action that uploads a Chrome extension ZIP to the Chrome Web Store and submits it for review, through the Chrome Web Store API v2.

- **No stored secret needed.** It takes a short-lived access token, which `google-github-actions/auth` can mint through Workload Identity Federation. Nothing long-lived sits in your repository secrets.
- **Safe to re-run.** It reads the store status before writing anything. A version that is already published or in review is skipped. A version that the store would refuse, or a review in progress for another version, stops the run with a clear message before anything is uploaded. After submitting, it reads the status again to confirm which version went to review.
- **Readable and dependency free.** About 500 lines of plain JavaScript in `src/`, importing only Node.js built-ins. What you read is what runs: no bundle, no `node_modules`, no build step.
- **Testable without risk.** `dry-run: true` checks your ZIP, that your credentials can read the item, and the store state, then stops before uploading.
- **Existing setups work too.** It also accepts an OAuth client ID, client secret and refresh token.

The Chrome Web Store API v1.1 stops working on 15 October 2026. This action only calls v2.

Not affiliated with or endorsed by Google. Chrome Web Store is a trademark of Google LLC.

## Before you start

- The extension must already exist in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole): uploading the first ZIP there creates the item and its ID. The API cannot create an item. Before the first publish, Google requires the Store listing and Privacy tabs to be filled out.
- Google requires 2-step verification on the account that owns the publisher.
- Every release needs a `version` in `manifest.json` higher than the published one. The action stops before uploading when it is not.
- The ZIP holds the contents of your extension folder, with `manifest.json` at its root, not the folder itself.

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

The build runs in its own job, so your build tools and their dependencies never run next to the store token. The publish job only downloads the ZIP, gets the token and runs this action. The concurrency group keeps two releases from uploading at the same time, because the store submits whichever package was uploaded last.

The one-time Google Cloud setup is described in [Setting up Workload Identity Federation](#setting-up-workload-identity-federation). With the provider it creates, every run must come from a tag. A run from a branch fails in the `google-github-actions/auth` step, before this action starts, with "The given credential is rejected by the attribute condition".

### Trying it first

Add `dry-run: true` to either example. The run reads the ZIP, obtains the token, fetches the item status and prints what a real run would do. It sends nothing to the store except that status request. To start a dry run by hand, give the workflow a `workflow_dispatch` trigger and pick a tag under "Use workflow from".

The status request also accepts a read-only token, so a dry run proves that the credentials can read the item. Write access is first used by the upload.

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
| `zip` | yes | | Path to the extension ZIP, with `manifest.json` at its root |
| `publish` | no | `true` | `false` uploads the package as a draft without submitting it |
| `dry-run` | no | `false` | `true` stops after the status check and reports what would happen |
| `publish-type` | no | `default` | `default` makes the version live once it passes review. `staged` holds the approved version until you publish it in the dashboard or with a separate publish call to the API. You have 30 days after approval, then it reverts to a draft and needs a new review. This action does not publish a staged version, even when re-run |

## Outputs

| Output | Description |
| --- | --- |
| `result` | `submitted`, `uploaded` (when `publish` is `false`), `skipped` (this version was already in the store) or `dry-run` (a dry run that would upload) |
| `state` | Store state of this version at the end, such as `PENDING_REVIEW`, `STAGED` or `PUBLISHED`. Empty when `result` is `uploaded` or `dry-run`, or when the store reports no state after submitting |
| `version` | The version read from `manifest.json` in the ZIP |

## What it does

1. Reads `manifest.json` from the ZIP and checks the version, before any network call. A ZIP whose manifest sits in a subfolder is refused with a hint, and so is a CRX file.
2. Fetches the item status and decides:

   | Store state | What the action does |
   | --- | --- |
   | This version is published, in review, approved or published to testers | Nothing. `result` is `skipped` and the step succeeds |
   | This version was rejected or its review was cancelled | Fails. Resubmit it from the dashboard or release a new version |
   | The published version is equal or higher | Fails without uploading, because the store only accepts a higher version |
   | Another version is in review | Fails without uploading, because the store refuses new packages during a review |
   | Another version is approved but not published | Fails and asks you to publish or cancel it in the dashboard |
   | Anything else | Continues |

   A taken down item or one with a policy warning gets a warning in the log, and the run continues.

3. Stops here on a dry run.
4. Uploads the ZIP, then checks the status every 10 seconds, up to 30 times, while the store processes it. A check that fails with a network error or HTTP 429, 500, 502, 503 or 504 counts as one of the 30, and three such failures in a row end the run. If processing takes longer, the run fails without submitting. The store may still finish the package as a draft, or the upload may fail, so check the dashboard before re-running.
5. Submits the version for review, unless `publish` is `false`. Warnings the store returns appear as warning annotations.
6. Reads the status once more. If a different version is now in review, another run replaced the package before this one submitted it, and the run fails.

Store errors are reported with the HTTP status, the store's message and a hint for the common causes.

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

**4. Create an identity pool and a GitHub provider.** The provider accepts a GitHub token only when the owner ID, the repository ID and a tag ref all match. That tag rule is enforced here.

```bash
OWNER_ID=12345678
REPO_ID=987654321
gcloud iam workload-identity-pools create cws-publish --location=global --display-name="Chrome Web Store publishing"
gcloud iam workload-identity-pools providers create-oidc github \
  --location=global --workload-identity-pool=cws-publish \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.ref_type=assertion.ref_type" \
  --attribute-condition="assertion.repository_owner_id == '$OWNER_ID' && assertion.repository_id == '$REPO_ID' && assertion.ref_type == 'tag'"
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

### Requiring an approval before each upload

Anyone who can create a tag in the repository can publish. To add a person in the loop:

1. Create an environment named `chrome-web-store` in the repository settings, with yourself as a required reviewer and a deployment rule that allows `v*` tags. Required reviewers work on public repositories on every GitHub plan. On private repositories they depend on your plan.
2. Add `environment: chrome-web-store` to the publishing job.
3. Append `&& assertion.environment == 'chrome-web-store'` to the provider condition of step 4, so no other job can mint the token:

```bash
OWNER_ID=12345678
REPO_ID=987654321
gcloud iam workload-identity-pools providers update-oidc github \
  --location=global --workload-identity-pool=cws-publish \
  --attribute-condition="assertion.repository_owner_id == '$OWNER_ID' && assertion.repository_id == '$REPO_ID' && assertion.ref_type == 'tag' && assertion.environment == 'chrome-web-store'"
```

A tag ruleset that limits who can create `v*` tags narrows it further.

### Publishing from a branch

If you release from a branch instead of tags, replace `assertion.ref_type == 'tag'` with `assertion.ref == 'refs/heads/main' && assertion.event_name == 'push'`, using your release branch. Do not remove the ref check: without it, every workflow in the repository can publish, including runs triggered by pull requests.

## Trust and security

### Every request the action makes

| When | Request |
| --- | --- |
| Refresh token flow only | `POST https://oauth2.googleapis.com/token` with the client ID, client secret and refresh token |
| Always | `GET https://chromewebstore.googleapis.com/v2/publishers/{publisher-id}/items/{item-id}:fetchStatus` |
| Unless skipped, refused or a dry run | `POST https://chromewebstore.googleapis.com/upload/v2/publishers/{publisher-id}/items/{item-id}:upload` with the ZIP |
| While the upload is processing | `GET ...:fetchStatus` again, every 10 seconds, up to 30 times |
| After a successful upload, unless `publish` is `false` | `POST https://chromewebstore.googleapis.com/v2/publishers/{publisher-id}/items/{item-id}:publish` with `{"publishType": ...}` |
| After submitting | `GET ...:fetchStatus` once, to confirm which version is in review |

The hosts are fixed in the code. There is no input to change them, redirects are refused rather than followed, and the test settings described under [Development](#development) only accept loopback addresses. `publisher-id` and `item-id` are validated before they are placed in a URL.

### What it does not do

- It does not print credentials. `access-token`, `client-id`, `client-secret` and `refresh-token` are masked before the first log line, and a token minted from a refresh token is masked as soon as Google returns it, also before the first log line.
- It does not return credentials. The outputs are `result`, `state` and `version`.
- It writes no file other than its step outputs, starts no process and sends no telemetry.
- It has no dependencies, not even development ones. `package.json` exists only to hold the test command.

### The code

| File | Lines | Role |
| --- | --- | --- |
| [`src/main.mjs`](src/main.mjs) | ~110 | Reads and validates inputs, masks secrets, sets outputs |
| [`src/store.mjs`](src/store.mjs) | ~200 | The store calls and the state decisions |
| [`src/zip.mjs`](src/zip.mjs) | ~120 | Reads `manifest.json` from the ZIP, with checksum verification |
| [`src/token.mjs`](src/token.mjs) | ~40 | Refresh token exchange |
| [`src/runner.mjs`](src/runner.mjs) | ~50 | GitHub Actions inputs, outputs, masking and annotations |
| [`src/errors.mjs`](src/errors.mjs) | ~15 | The error type for failures shown as an error annotation, and network error wording |

### How it is checked

- Every pull request runs the tests on Linux, Windows and macOS with a coverage floor of 95% of lines, and runs the action itself from `action.yml` against a mock store. See [ci.yml](.github/workflows/ci.yml).
- [CodeQL](.github/workflows/codeql.yml) scans the JavaScript and the workflows on every pull request, every push to `main` and weekly. Dependabot keeps the workflow actions current.
- Releases are immutable: once `v1.0.0` is published, its tag and contents cannot change. `v1` points at the newest `1.x` release. [The workflow that moves it](.github/workflows/major-tag.yml) always points `v1` at the highest `1.x.y` release, refuses one that is not immutable, and runs one release at a time. If your organization requires full commit SHAs, pin the commit of a release.

### Your side

The linked service account can manage every item of the publisher. Bind only repositories you control, and consider the approval step above.

Report a vulnerability as described in [SECURITY.md](SECURITY.md).

## Limits

- The API cannot create an item or change its visibility. After you change visibility in the dashboard, publish once by hand with the new visibility: until then the API cannot publish ([Google's note](https://developer.chrome.com/docs/webstore/using-api)).
- One service account per publisher, shared by all its extensions.
- Items opted in to Verified CRX Uploads are not supported: the store requires a signed CRX for them, and this action uploads ZIP packages only.
- The upload request has 10 minutes to finish. ZIP64 archives are not supported.
- Partial rollout (`deployPercentage`), skipping review and `blockOnWarnings` are not exposed.

## Development

Node.js 24 or later, no install step:

```bash
npm test
```

The tests run the action against a local mock of the store API. `CWS_API_BASE` and `CWS_TOKEN_ENDPOINT` point the action at that mock, and it refuses them unless they are loopback `http` addresses.

## License

[MIT](LICENSE)
