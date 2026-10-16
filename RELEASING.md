# Releases

[Release Please](https://github.com/googleapis/release-please) proposes the next
version in a pull request. A maintainer reviews the complete diff since the last
release, the version and the changelog before merging it. The release workflow
publishes that merged commit after its required CI and CodeQL push jobs succeed, then
updates the floating major tag.

## Version decisions

`version.txt` and `.release-please-manifest.json` record the same version. The
action runs TypeScript source directly, so there is no npm package or build
artifact to publish. The initial version is `1.2.2`, with its released commit as
the bootstrap boundary.

Use [Semantic Versioning](https://semver.org/): compatible fixes increment PATCH,
compatible features or public API deprecations increment MINOR, and incompatible
public API changes increment MAJOR. Review both the publishing action and the
signing action, including their inputs, outputs, defaults and runtime requirements.
Commit prefixes propose a version; the compatibility impact determines it.

`fix:` and `feat:` commits normally produce release proposals. Documentation,
CI and development dependency changes that preserve installed behavior do not
need a release. For a compatibility-relevant change that the bot does not detect,
use the documented [Release-As footer](https://github.com/googleapis/release-please#how-do-i-change-the-version-number)
to request the reviewed version. To correct an open proposal, use that mechanism
and let the bot regenerate its manifest, version file and notes before merging.

This workflow publishes stable `vMAJOR.MINOR.PATCH` releases only. Prereleases
need a separate reviewed workflow change before use.

## Release review

1. Review the complete comparison with the previous immutable release. Check the
   proposed SemVer version and edit the release notes where needed.
2. Check that the release PR changes only `CHANGELOG.md`, `version.txt` and
   `.release-please-manifest.json`. Merge runtime and workflow changes through
   separate PRs so the release decision has a fixed source diff.
3. Approve any CI runs awaiting approval on the bot-created PR, then review the
   required checks before merging. The workflow uses the repository's short-lived
   `GITHUB_TOKEN`, with no personal access token or separate GitHub App.
4. Merge the release PR as a human maintainer. Bot merges do not authorize
   publication. Publication waits for all six CI jobs and both CodeQL
   jobs to succeed on its exact merge commit. A passing PR run, scheduled run,
   skipped job or successful run for another commit does not authorize publication.
5. Inspect the [Release workflow](https://github.com/hamzahamidi/publish-to-chrome-web-store/actions/workflows/release.yml)
   and the new release. Its title equals its exact tag. Its notes link to the
   release PR and source commit. Confirm the
   [Marketplace listing](https://github.com/marketplace/actions/publish-to-chrome-web-store)
   displays the intended version; publication through the release API has not
   been verified to update the Marketplace listing automatically.

The bot's PR is a public record of the release decision. A sole maintainer's
review is not independent two-person approval. Workflow changes need the same
attention as runtime changes because they control release credentials.

## Publication and recovery

The proposal job cannot publish a release. The publication job reads release
metadata from the merged PR's SHA, checks its membership in `main`, and verifies
successful required jobs from push runs of the two expected workflow paths. CI
and CodeQL each call the reusable release workflow after their required jobs
succeed. The caller's workflow may still be running its release jobs; all eight
required test and analysis jobs must already be complete and successful.
Publication executes only scripts checked out at its triggering `main` commit; it does not
download artifacts or run code from a triggering PR. Release operations and the
separate major-tag workflow share one concurrency group.

Exact version tags and published contents are immutable. `v1`, `v2` and later
major aliases intentionally move to the newest immutable stable release of their
major. Alias maintenance runs directly after publication because releases created
with `GITHUB_TOKEN` do not trigger the separate release-event workflow.

The pending release label remains until publication and alias maintenance both
succeed. If either fails, correct the cause and run the Release workflow manually
on `main`. It checks CI again and reuses an existing immutable release only when
its exact tag points to the reviewed commit. It never moves an exact version tag,
replaces release contents or publishes a second version merely to retry an alias.
For transient CI failures, rerun the failed push run for the release commit.
If the source needs a change, leave that version unpublished, remove the pending
label from the merged release PR, and merge the correction through a separate
PR. Run the proposal workflow to prepare the next reviewed version. Version
numbers may be skipped; a failed candidate does not authorize bypassing checks.

Repository settings must allow Actions to create pull requests, while default
workflow permissions remain read-only. Enable immutable releases before
publication. An API or permission failure stops publication or alias maintenance;
it does not justify adding a long-lived token. GitHub can refuse tag changes when
an older release commit's workflow files differ from current `main`; resolve the
workflow difference through reviewed changes before retrying.

For security-sensitive consumers, pin the full commit SHA shown by an immutable
release and use [Dependabot](https://docs.github.com/en/code-security/dependabot)
for reviewed updates. A floating major alias selects compatible updates but is
not a fixed source reference. CI, CodeQL and Scorecard provide evidence about
checks and practices, not a guarantee that a release is safe.
