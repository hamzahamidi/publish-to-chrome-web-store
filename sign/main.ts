import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isCrx } from '../src/crx.ts';
import { ActionError } from '../src/errors.ts';
import { error, getInput, info, mask, setOutput } from '../src/runner.ts';
import { packCrx } from '../src/sign.ts';
import { readManifest } from '../src/zip.ts';

function main(): void {
  const privateKey = getInput('private-key', { required: true });
  mask(privateKey);
  const zipPath = getInput('zip', { required: true });
  const crxPath = getInput('crx') || zipPath.replace(/\.zip$/i, '') + '.crx';

  let zip: Buffer;
  try {
    if (!statSync(zipPath).isFile()) throw new ActionError(`${JSON.stringify(zipPath)} is not a regular file.`);
    zip = readFileSync(zipPath);
  } catch (cause) {
    if (cause instanceof ActionError) throw cause;
    const { code, message } = cause as NodeJS.ErrnoException;
    throw new ActionError(`Cannot read ${JSON.stringify(zipPath)}: ${code === 'ENOENT' ? 'no such file' : message}.`);
  }
  if (sameFile(zipPath, crxPath)) throw new ActionError('Input crx must name a different file than zip.');
  if (isCrx(zip)) {
    throw new ActionError(`${JSON.stringify(zipPath)} is already a CRX package. Pass the extension ZIP to sign, or give this CRX to the publish action's crx input.`);
  }
  const { version } = readManifest(zip, JSON.stringify(zipPath));
  const { crx, crxId } = packCrx(zip, privateKey.replace(/\\n/g, '\n'));
  try {
    mkdirSync(dirname(crxPath), { recursive: true });
    writeFileSync(crxPath, crx);
  } catch (cause) {
    throw new ActionError(`Cannot write ${JSON.stringify(crxPath)}: ${(cause as Error).message}.`);
  }
  info(`Signed version ${version} as ${JSON.stringify(crxPath)} with the key for ID ${crxId}.`);
  setOutput('crx', crxPath);
  setOutput('version', version);
  setOutput('crx-id', crxId);
}

function sameFile(a: string, b: string): boolean {
  const source = statSync(a, { bigint: true });
  const target = statSync(b, { bigint: true, throwIfNoEntry: false });
  return target !== undefined && source.dev === target.dev && source.ino === target.ino;
}

try {
  main();
} catch (cause) {
  if (cause instanceof ActionError) error(cause.details ? `${cause.message}\n${cause.details}` : cause.message);
  else error(`Unexpected failure: ${(cause as Error | undefined)?.stack ?? cause}`);
  process.exitCode = 1;
}
