import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packCrx } from '../src/sign.ts';

const chrome = process.env.CHROME ?? 'google-chrome';
const dir = mkdtempSync(join(tmpdir(), 'crx-compat-'));
try {
  const extension = join(dir, 'ext');
  mkdirSync(extension);
  writeFileSync(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'CRX packer check', version: '1.2.3' }));
  writeFileSync(join(extension, 'background.js'), 'chrome.runtime.onInstalled.addListener(() => {});\n');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const keyPath = join(dir, 'key.pem');
  writeFileSync(keyPath, privateKey, { mode: 0o600 });

  const args = [`--pack-extension=${extension}`, `--pack-extension-key=${keyPath}`, `--user-data-dir=${join(dir, 'profile')}`, '--no-first-run'];
  const command = process.platform === 'linux' && !process.env.DISPLAY ? ['xvfb-run', '-a', chrome, ...args] : [chrome, ...args];
  const packed = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8' });
  if (packed.error) throw packed.error;
  assert.equal(packed.status, 0, `${command.join(' ')} exited ${packed.status ?? packed.signal}\n${packed.stdout}${packed.stderr}`);
  const crx = readFileSync(join(dir, 'ext.crx'));
  const archive = crx.subarray(12 + crx.readUInt32LE(8));
  const version = spawnSync(chrome, ['--version'], { encoding: 'utf8' }).stdout.trim();

  assert.equal(Buffer.compare(packCrx(archive, privateKey).crx, crx), 0, `our CRX differs from the one ${version} wrote`);
  console.log(`packCrx output is byte-identical to ${version} --pack-extension (${crx.length} bytes).`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
