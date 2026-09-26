import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { crxArchive } from '../src/crx.ts';
import { ActionError } from '../src/errors.ts';
import { packCrx } from '../src/sign.ts';
import { readManifest } from '../src/zip.ts';
import { extensionZip, makeZip } from './helpers.ts';

const SIGN_MAIN = resolve(import.meta.dirname, '../sign/main.ts');
const dir = mkdtempSync(join(tmpdir(), 'cws-sign-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

function readFields(bytes: Buffer): Map<number, Buffer[]> {
  const fields = new Map<number, Buffer[]>();
  let offset = 0;
  const varint = () => {
    let value = 0;
    let shift = 1;
    for (;;) {
      const byte = bytes[offset++]!;
      value += (byte & 0x7f) * shift;
      if (byte < 0x80) return value;
      shift *= 128;
    }
  };
  while (offset < bytes.length) {
    const tag = varint();
    assert.equal(tag % 8, 2, 'every CRX3 header field is length delimited');
    const length = varint();
    const number = Math.floor(tag / 8);
    fields.set(number, [...(fields.get(number) ?? []), bytes.subarray(offset, offset + length)]);
    offset += length;
  }
  return fields;
}

describe('packCrx', () => {
  const zip = extensionZip('3.2.1');
  const { crx, crxId } = packCrx(zip, privateKey);

  it('writes a CRX3 whose archive is the ZIP unchanged', () => {
    assert.equal(crx.toString('latin1', 0, 4), 'Cr24');
    assert.equal(crx.readUInt32LE(4), 3);
    assert.deepEqual(crxArchive(crx, 'x.crx'), zip);
    assert.equal(readManifest(crxArchive(crx, 'x.crx')).version, '3.2.1');
  });

  it('signs the header and archive with RSA SHA-256 the way Chrome verifies it', () => {
    const header = readFields(crx.subarray(12, 12 + crx.readUInt32LE(8)));
    const [proof] = header.get(2)!;
    const [signedHeaderData] = header.get(10000)!;
    const proofFields = readFields(proof!);
    const publicKey = proofFields.get(1)![0]!;
    const signature = proofFields.get(2)![0]!;
    const context = Buffer.concat([Buffer.from('CRX3 SignedData\x00', 'latin1'), Buffer.alloc(4), signedHeaderData!, zip]);
    context.writeUInt32LE(signedHeaderData!.length, 16);
    assert.equal(verify('sha256', context, createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), signature), true);
    const declaredId = readFields(signedHeaderData!).get(1)![0]!;
    assert.deepEqual(declaredId, createHash('sha256').update(publicKey).digest().subarray(0, 16));
    assert.match(crxId, /^[a-p]{32}$/);
  });

  it('names an encrypted key instead of calling it invalid', () => {
    const encrypted = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: 'x' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    assert.throws(() => packCrx(zip, encrypted.privateKey), (error) => error instanceof ActionError && /The private key is encrypted/.test(error.message));
  });

  it('refuses a key that is not RSA, or not a key at all', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    assert.throws(() => packCrx(zip, ec.privateKey), (error) => error instanceof ActionError && /is ec, and the Chrome Web Store needs an RSA key/.test(error.message));
    assert.throws(() => packCrx(zip, 'not a key'), (error) => error instanceof ActionError && /is not a PEM private key/.test(error.message));
  });
});

function runSign(inputs: Record<string, string>): Promise<{ code: number | null; stdout: string; outputs: string }> {
  const output = join(dir, `output-${Object.keys(inputs).join('-')}-${Date.now()}`);
  writeFileSync(output, '');
  const env = Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value]));
  return new Promise((done) => {
    const child = spawn(process.execPath, [SIGN_MAIN], { env: { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: output, ...env } });
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stdout += chunk));
    child.on('close', (code) => done({ code, stdout, outputs: readFileSync(output, 'utf8') }));
  });
}

describe('sign action', () => {
  it('writes the CRX next to the ZIP and sets its outputs', async () => {
    const zipPath = join(dir, 'ext-4.5.6.zip');
    writeFileSync(zipPath, extensionZip('4.5.6'));
    const run = await runSign({ zip: zipPath, 'private-key': privateKey });
    assert.equal(run.code, 0, run.stdout);
    const crxPath = join(dir, 'ext-4.5.6.crx');
    assert.ok(existsSync(crxPath));
    assert.equal(readManifest(crxArchive(readFileSync(crxPath), 'crx')).version, '4.5.6');
    assert.match(run.outputs, new RegExp(`crx<<EOF_[\\w-]+\\r?\\n${crxPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\r?\\n`));
    assert.match(run.outputs, /version<<EOF_[\w-]+\r?\n4\.5\.6\r?\n/);
    const printed = run.stdout.split(/\r?\n/).filter((line) => !line.startsWith('::add-mask::')).join('\n');
    assert.ok(!printed.includes('PRIVATE KEY'), 'the key must not be printed');
  });

  it('creates the output folder, and refuses a CRX given as the ZIP', async () => {
    const zipPath = join(dir, 'plain.zip');
    writeFileSync(zipPath, extensionZip('1.1'));
    const nested = join(dir, 'out', 'deep', 'plain.crx');
    const run = await runSign({ zip: zipPath, crx: nested, 'private-key': privateKey });
    assert.equal(run.code, 0, run.stdout);
    assert.ok(existsSync(nested));
    const again = await runSign({ zip: nested, crx: join(dir, 'twice.crx'), 'private-key': privateKey });
    assert.equal(again.code, 1);
    assert.match(again.stdout, /is already a CRX package\. Pass the extension ZIP to sign, or give this CRX to the publish action's crx input\./);
  });

  it('refuses a ZIP without a manifest at its root before signing', async () => {
    const zipPath = join(dir, 'nested.zip');
    writeFileSync(zipPath, makeZip([{ name: 'dist/manifest.json', data: '{"version":"1.0"}' }]));
    const run = await runSign({ zip: zipPath, 'private-key': privateKey });
    assert.equal(run.code, 1);
    assert.match(run.stdout, /no manifest\.json at its root/);
    assert.ok(!existsSync(join(dir, 'nested.crx')));
  });

  it('refuses a missing key, a missing ZIP and an output path equal to the ZIP', async () => {
    const zipPath = join(dir, 'ext.zip');
    writeFileSync(zipPath, extensionZip('1.0'));
    assert.match((await runSign({ zip: zipPath })).stdout, /Input private-key is required\./);
    assert.match((await runSign({ zip: join(dir, 'none.zip'), 'private-key': privateKey })).stdout, /no such file/);
    assert.match((await runSign({ zip: zipPath, crx: zipPath, 'private-key': privateKey })).stdout, /Input crx must name a different file than zip\./);
    assert.match((await runSign({ zip: zipPath, crx: join(dir, '.', 'ext.zip'), 'private-key': privateKey })).stdout, /Input crx must name a different file than zip\./);
    assert.equal(readFileSync(zipPath).length, extensionZip('1.0').length);
  });
});
