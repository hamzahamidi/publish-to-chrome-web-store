import { readFileSync, writeFileSync } from 'node:fs';
import { ActionError } from '../src/errors.ts';
import { error, getInput, info, mask, setOutput } from '../src/runner.ts';
import { packCrx } from '../src/sign.ts';
import { readManifest } from '../src/zip.ts';

function main(): void {
  const privateKey = getInput('private-key', { required: true });
  mask(privateKey);
  const zipPath = getInput('zip', { required: true });
  const crxPath = getInput('crx') || zipPath.replace(/\.zip$/i, '') + '.crx';
  if (crxPath === zipPath) throw new ActionError('Input crx must differ from zip.');

  let zip: Buffer;
  try {
    zip = readFileSync(zipPath);
  } catch (cause) {
    const { code, message } = cause as NodeJS.ErrnoException;
    throw new ActionError(`Cannot read ${JSON.stringify(zipPath)}: ${code === 'ENOENT' ? 'no such file' : message}.`);
  }
  const { version } = readManifest(zip, JSON.stringify(zipPath));
  const { crx, crxId } = packCrx(zip, privateKey.replace(/\\n/g, '\n'));
  writeFileSync(crxPath, crx);
  info(`Signed version ${version} as ${JSON.stringify(crxPath)} with the key for ID ${crxId}.`);
  setOutput('crx', crxPath);
  setOutput('version', version);
  setOutput('crx-id', crxId);
}

try {
  main();
} catch (cause) {
  if (cause instanceof ActionError) error(cause.details ? `${cause.message}\n${cause.details}` : cause.message);
  else error(`Unexpected failure: ${(cause as Error | undefined)?.stack ?? cause}`);
  process.exitCode = 1;
}
