# Releases

[Release Please](https://github.com/googleapis/release-please-action) manages
version proposals, changelogs, tags, GitHub releases and release PR labels.
`version.txt` and `.release-please-manifest.json` use its `simple` strategy,
starting at `1.2.2`. The action runs TypeScript source directly, so no npm package
or build artifact needs publishing.

## Review and publication

1. Merge features and fixes through PRs. The CI workflow runs tests on Linux,
   Windows and macOS, the mock-store action checks, Chrome signing compatibility,
   and CodeQL. Its release job depends on all of them succeeding.
2. Release Please opens or updates a release PR. Review the complete diff since
   the previous release, its proposed version and its changelog. Use
   [Semantic Versioning](https://semver.org/) based on compatibility across both
   actions' inputs, outputs, defaults and runtime requirements. Commit prefixes
   propose a version; the public compatibility contract determines it.
3. Approve any bot-created PR workflow runs awaiting approval and review the
   required checks. Merge the reviewed release PR with its generated
   `chore(main): release VERSION` title. On that push, after the checks succeed,
   Release Please publishes the version. Ordinary pushes update proposals without
   publishing an older pending release candidate.
4. Inspect the release and the
   [Marketplace listing](https://github.com/marketplace/actions/publish-to-chrome-web-store).
   Automatic Marketplace updates through API-created releases remain unverified.

Documentation, CI and development dependency changes that preserve installed
behavior do not need a release. To correct a proposed version or request one for
a change the bot does not detect, use its documented
[Release-As footer](https://github.com/googleapis/release-please#how-do-i-change-the-version-number).
This workflow is intended for stable releases. Prereleases need a reviewed
workflow configuration change first.

## Security and retries

The default token permission is read-only. Only the release job gets repository
and PR write permissions, using the short-lived `GITHUB_TOKEN`. Repository
settings must allow Actions to create PRs and enable immutable releases.

Published exact version tags are immutable. The existing major-tag script runs
after Release Please and refuses to move `v1` or another major alias to a release
that is not immutable. It also runs when retrying a successful publication whose
alias update failed, using the triggering commit's `version.txt` on retries.
Release and alias jobs share one concurrency group with a queue of up to 100 jobs.

For transient failures, rerun the CI workflow for the release commit. If a source
change is needed, leave that candidate unpublished and resolve its pending release
PR using Release Please's recovery guidance before preparing the next proposal.
Do not move an exact version tag or replace published contents.

Security-sensitive consumers should pin the full commit SHA of an immutable
release. A major alias intentionally follows compatible releases. A maintainer
reviewing a bot-created release PR provides a public decision record, rather than
independent two-person approval.
