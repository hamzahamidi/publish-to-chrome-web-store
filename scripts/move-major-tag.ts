const RELEASE_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

interface Release {
  tag_name?: string;
  draft?: boolean;
  prerelease?: boolean;
  immutable?: boolean;
}

interface GitRef {
  object?: { type?: string; sha?: string };
  message?: string;
}

interface Candidate {
  release: Release;
  minor: number;
  patch: number;
}

const api = process.env.GITHUB_API_URL || 'https://api.github.com';
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const tag = process.env.TAG ?? '';

const escape = (text: string): string => String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function fail(message: string): never {
  console.log(`::error::${escape(message)}`);
  process.exit(1);
}

async function github<T>(method: string, path: string, body?: object): Promise<{ status: number; data: T }> {
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
  return { status: response.status, data: (await response.json().catch(() => ({}))) as T };
}

const match = RELEASE_TAG.exec(tag) ?? fail(`Release tag ${JSON.stringify(tag)} is not vMAJOR.MINOR.PATCH.`);
const major = Number(match[1]);

const candidates: Candidate[] = [];
for (let page = 1; ; page++) {
  const list = await github<Release[]>('GET', `/releases?per_page=100&page=${page}`);
  if (list.status !== 200) fail(`Listing releases failed (HTTP ${list.status}).`);
  for (const release of list.data) {
    const [, releaseMajor, minor, patch] = (RELEASE_TAG.exec(release.tag_name ?? '') ?? []).map(Number);
    if (releaseMajor === major && minor !== undefined && patch !== undefined && !release.draft && !release.prerelease) candidates.push({ release, minor, patch });
  }
  if (list.data.length < 100) break;
}
if (candidates.length === 0) fail(`No published v${major}.x.y release was found.`);
const newest = candidates.reduce((best, next) => ((next.minor - best.minor || next.patch - best.patch) > 0 ? next : best)).release;
if (newest.tag_name !== tag) console.log(`${tag} is not the newest v${major} release, so v${major} follows ${newest.tag_name}.`);
if (newest.immutable !== true) {
  fail(`Release ${newest.tag_name} is not immutable, so v${major} stays where it is. Turn on release immutability in the repository settings, then publish a new release.`);
}

const ref = await github<GitRef>('GET', `/git/ref/tags/${newest.tag_name}`);
if (ref.status !== 200) fail(`Tag ${newest.tag_name} was not found (HTTP ${ref.status}).`);
let commit = ref.data.object?.sha;
if (ref.data.object?.type === 'tag') {
  const annotated = await github<GitRef>('GET', `/git/tags/${commit}`);
  if (annotated.status !== 200) fail(`Annotated tag ${newest.tag_name} could not be read (HTTP ${annotated.status}).`);
  commit = annotated.data.object?.sha;
}
if (!commit) fail(`Tag ${newest.tag_name} does not resolve to a commit.`);

const current = await github<GitRef>('GET', `/git/ref/tags/v${major}`);
if (current.status === 200 && current.data.object?.sha === commit) {
  console.log(`v${major} already points at ${newest.tag_name} (${commit.slice(0, 12)}).`);
  process.exit(0);
}
if (current.status !== 200 && current.status !== 404) fail(`Reading v${major} failed (HTTP ${current.status}).`);
const moved = current.status === 200
  ? await github<GitRef>('PATCH', `/git/refs/tags/v${major}`, { sha: commit, force: true })
  : await github<GitRef>('POST', '/git/refs', { ref: `refs/tags/v${major}`, sha: commit });
if (moved.status !== 200 && moved.status !== 201) {
  fail(
    `Moving v${major} failed (HTTP ${moved.status}): ${moved.data.message ?? ''}`
      + (moved.status === 403 || moved.status === 422
        ? `\nIf the workflow files of ${newest.tag_name} differ from the default branch, GITHUB_TOKEN may not move the tag. Move v${major} by hand in that case.`
        : ''),
  );
}
console.log(`v${major} now points at ${newest.tag_name} (${commit.slice(0, 12)}).`);
