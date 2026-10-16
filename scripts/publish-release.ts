import { appendFileSync } from 'node:fs';

interface PullRequest {
  number: number;
  merged: boolean;
  merge_commit_sha: string;
  user: { login: string };
  merged_by: { type: string } | null;
  base: { ref: string };
  head: { ref: string; repo: { full_name: string } | null };
}

interface Release {
  tag_name: string;
  name: string;
  draft: boolean;
  prerelease: boolean;
  immutable: boolean;
}

interface Run {
  id: number;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  event: string;
  path: string;
  status: string;
  conclusion: string | null;
}

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY ?? '';
const token = process.env.GITHUB_TOKEN;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const checks = {
  'ci.yml': ['Tests (ubuntu-latest)', 'Tests (windows-latest)', 'Tests (macos-latest)', 'Action against a mock store', "Signing matches Chrome's packer", 'Sign and upload a CRX against a mock store'],
  'codeql.yml': ['Analyze (actions)', 'Analyze (javascript-typescript)'],
};

async function github<T>(path: string, method = 'GET', body?: object): Promise<T | undefined> {
  const response = await fetch(`${api}/repos/${repository}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (response.status === 404 && method === 'GET') return undefined;
  if (!response.ok) throw new Error(`${method} ${path} failed (HTTP ${response.status}).`);
  return await response.json() as T;
}

async function required<T>(path: string): Promise<T> {
  const value = await github<T>(path);
  if (value === undefined) throw new Error(`${path} was not found.`);
  return value;
}

async function pages<T>(path: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; ; page++) {
    const batch = await required<T[]>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    result.push(...batch);
    if (batch.length < 100) return result;
  }
}

async function file(path: string, sha: string): Promise<string> {
  const data = await required<{ content: string; encoding: string }>(`/contents/${path}?ref=${sha}`);
  if (data.encoding !== 'base64') throw new Error(`Unexpected encoding for ${path}.`);
  return Buffer.from(data.content, 'base64').toString('utf8');
}

function newer(version: string, previous: string): boolean {
  const next = version.split('.').map(BigInt);
  const old = previous.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (next[index] !== old[index]) return next[index]! > old[index]!;
  }
  return false;
}

async function main(): Promise<void> {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are required.');
  const issues = await pages<{ number: number; pull_request?: object }>('/issues?state=closed&labels=autorelease%3A%20pending');
  const pending: PullRequest[] = [];
  for (const issue of issues) {
    if (!issue.pull_request) continue;
    const pr = await required<PullRequest>(`/pulls/${issue.number}`);
    if (pr.merged && pr.base.ref === 'main') pending.push(pr);
  }
  if (pending.length === 0) {
    console.log('No merged release PR is awaiting publication.');
    return;
  }
  if (pending.length !== 1) throw new Error('More than one merged release PR is awaiting publication. Resolve the pending labels before retrying.');
  const pr = pending[0]!;
  const sha = pr.merge_commit_sha;
  if (pr.user.login !== 'github-actions[bot]' || pr.head.ref !== 'release-please--branches--main' || pr.head.repo?.full_name !== repository || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('The pending PR is not a same-repository Release Please PR.');
  }
  if (pr.merged_by?.type !== 'User') throw new Error('A human maintainer must merge the release PR.');
  const files = await pages<{ filename: string }>(`/pulls/${pr.number}/files`);
  const expectedFiles = ['.release-please-manifest.json', 'CHANGELOG.md', 'version.txt'];
  if (files.length !== expectedFiles.length || files.some(({ filename }) => !expectedFiles.includes(filename))) {
    throw new Error('The release PR must change only the manifest, changelog and version.txt.');
  }
  const ancestry = await required<{ status: string }>(`/compare/${sha}...main`);
  if (!['ahead', 'identical'].includes(ancestry.status)) throw new Error('The release commit is not on main.');

  for (const [workflow, names] of Object.entries(checks)) {
    const { workflow_runs: runs } = await required<{ workflow_runs: Run[] }>(`/actions/workflows/${workflow}/runs?event=push&branch=main&head_sha=${sha}&per_page=1`);
    const run = runs[0];
    if (!run || run.head_sha !== sha || run.head_branch !== 'main' || run.head_repository.full_name !== repository || run.event !== 'push' || run.path !== `.github/workflows/${workflow}` || !(run.status === 'in_progress' || (run.status === 'completed' && run.conclusion === 'success'))) {
      console.log(`Waiting for successful ${workflow} on ${sha}.`);
      return;
    }
    const jobs: { name: string; status: string; conclusion: string | null }[] = [];
    for (let page = 1; ; page++) {
      const batch = await required<{ jobs: typeof jobs }>(`/actions/runs/${run.id}/jobs?filter=latest&per_page=100&page=${page}`);
      jobs.push(...batch.jobs);
      if (batch.jobs.length < 100) break;
    }
    if (!names.every((name) => jobs.some((job) => job.name === name && job.status === 'completed' && job.conclusion === 'success'))) {
      if (run.status === 'in_progress') {
        console.log(`Waiting for required ${workflow} jobs on ${sha}.`);
        return;
      }
      throw new Error(`${workflow} is missing successful required jobs for ${sha}.`);
    }
  }

  const version = (await file('version.txt', sha)).trim();
  const manifest = JSON.parse(await file('.release-please-manifest.json', sha)) as Record<string, string>;
  if (!versionPattern.test(version) || manifest['.'] !== version || Object.keys(manifest).length !== 1) {
    throw new Error('version.txt and the root manifest must agree on a stable MAJOR.MINOR.PATCH version.');
  }
  const tag = `v${version}`;
  const changelog = await file('CHANGELOG.md', sha);
  const entry = /^## (?:\[)?(\d+\.\d+\.\d+)(?:\])?[^\n]*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m.exec(changelog);
  if (entry?.[1] !== version || !entry[2]?.trim()) throw new Error('The first changelog entry must contain release notes for the approved version.');
  const releases = await pages<Release>('/releases');
  if (releases.some((release) => !release.draft && !release.prerelease && versionPattern.test(release.tag_name.slice(1)) && release.tag_name.startsWith('v') && newer(release.tag_name.slice(1), version))) {
    throw new Error('A newer stable version is already published.');
  }

  const refPath = `/git/ref/tags/${tag}`;
  const ref = await github<{ object: { sha: string; type: string } }>(refPath);
  if (ref && (ref.object.type !== 'commit' || ref.object.sha !== sha)) throw new Error(`${tag} already exists at a different object.`);
  let release = await github<Release>(`/releases/tags/${tag}`);
  if (!release) {
    release = await github<Release>('/releases', 'POST', {
      tag_name: tag,
      target_commitish: sha,
      name: tag,
      body: `${entry[2].trim()}\n\nRelease PR: https://github.com/${repository}/pull/${pr.number}\nSource commit: https://github.com/${repository}/commit/${sha}\n`,
      draft: false,
      prerelease: false,
    });
  }
  release = await required<Release>(`/releases/tags/${tag}`);
  const publishedRef = await required<{ object: { sha: string; type: string } }>(refPath);
  if (release.tag_name !== tag || release.name !== tag || release.draft || release.prerelease || release.immutable !== true || publishedRef.object.sha !== sha || publishedRef.object.type !== 'commit') {
    throw new Error(`${tag} must be an immutable stable release at the tested commit before its alias or labels can change.`);
  }
  console.log(`Published ${tag} at ${sha}.`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\npr=${pr.number}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`::error::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
  process.exitCode = 1;
});
