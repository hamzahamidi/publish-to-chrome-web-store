import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ActionError } from '../src/errors.ts';
import { readManifest } from '../src/zip.ts';
import { extensionZip, makeZip } from './helpers.ts';

const manifest = (version: string) => JSON.stringify({ manifest_version: 3, name: 'Test', version });

function fails(zip: Buffer, pattern: RegExp) {
  assert.throws(
    () => readManifest(zip, 'ext.zip'),
    (error) => error instanceof ActionError && pattern.test(error.message),
  );
}

const hasZip = spawnSync('zip', ['-v']).status === 0;

describe('readManifest', () => {
  it('reads the version from a deflated entry', () => {
    assert.equal(readManifest(extensionZip('1.2.3')).version, '1.2.3');
  });

  it('reads the version from a stored entry', () => {
    assert.equal(readManifest(extensionZip('4.0', { method: 0 })).version, '4.0');
  });

  it('accepts a byte order mark before the JSON', () => {
    assert.equal(readManifest(makeZip([{ name: 'manifest.json', data: `﻿${manifest('1.0')}` }])).version, '1.0');
  });

  it('skips a ZIP comment when locating the central directory', () => {
    const zip = extensionZip('2.0.0');
    const comment = Buffer.from('built by CI');
    zip.writeUInt16LE(comment.length, zip.length - 2);
    assert.equal(readManifest(Buffer.concat([zip, comment])).version, '2.0.0');
  });

  it('points at a manifest inside a folder, the usual packaging mistake', () => {
    fails(makeZip([{ name: 'dist/manifest.json', data: manifest('1.0') }]), /only "dist\/manifest\.json"\. Zip the contents of the extension folder/);
  });

  it('fails without a manifest', () => {
    fails(makeZip([{ name: 'readme.txt', data: 'hi' }]), /has no manifest\.json at its root\.$/);
  });

  it('fails when manifest.json appears twice', () => {
    fails(
      makeZip([
        { name: 'manifest.json', data: manifest('1.0') },
        { name: 'manifest.json', data: manifest('2.0') },
      ]),
      /more than once/,
    );
  });

  it('fails on invalid JSON', () => {
    fails(makeZip([{ name: 'manifest.json', data: '{ "version": ' }]), /is not valid JSON/);
  });

  for (const version of [undefined, 1, '', '1.2.3.4.5', '01.0', '1..0', '1.0-beta', '70000', '1.0\n::error::x']) {
    it(`rejects the version ${JSON.stringify(version)}`, () => {
      fails(makeZip([{ name: 'manifest.json', data: JSON.stringify({ version }) }]), /is not a valid extension version/);
    });
  }

  it('fails on a damaged entry', () => {
    fails(makeZip([{ name: 'manifest.json', data: manifest('1.0'), crc: 1 }]), /fails its checksum/);
  });

  it('fails on an encrypted entry', () => {
    fails(makeZip([{ name: 'manifest.json', data: manifest('1.0'), flags: 1 }]), /is encrypted/);
  });

  it('fails on an unsupported compression method', () => {
    fails(makeZip([{ name: 'manifest.json', data: manifest('1.0'), method: 12 }]), /compression method 12/);
  });

  it('fails on a file that is not a ZIP', () => {
    fails(Buffer.from('not a zip at all, just some text that is long enough'), /is not a valid ZIP file/);
    fails(Buffer.alloc(0), /is not a valid ZIP file/);
  });

  it('fails on a truncated ZIP', () => {
    const zip = extensionZip('1.0.0');
    fails(zip.subarray(20), /is not a valid ZIP file|truncated/);
  });

  it('points a CRX to the crx input instead of calling it a damaged ZIP', () => {
    const header = Buffer.alloc(12);
    header.write('Cr24', 0, 'latin1');
    header.writeUInt32LE(3, 4);
    fails(Buffer.concat([header, extensionZip('1.0')]), /is a CRX package, not a ZIP\.$/);
  });

  it('refuses ZIP64 archives', () => {
    const zip = extensionZip('1.0.0');
    zip.writeUInt16LE(0xffff, zip.length - 12);
    fails(zip, /ZIP64/);
  });

  it('refuses a manifest larger than 1 MiB', () => {
    fails(makeZip([{ name: 'manifest.json', data: JSON.stringify({ version: '1.0', pad: 'x'.repeat(1024 * 1024) }) }]), /larger than 1 MiB/);
  });

  it('reads archives written by the zip command, including streamed ones with data descriptors', { skip: !hasZip && 'zip is not installed' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'cws-zip-'));
    try {
      writeFileSync(join(dir, 'manifest.json'), manifest('3.1.4'));
      writeFileSync(join(dir, 'background.js'), '// empty\n');
      spawnSync('zip', ['-q', '-X', 'regular.zip', 'manifest.json', 'background.js'], { cwd: dir });
      assert.equal(readManifest(readFileSync(join(dir, 'regular.zip'))).version, '3.1.4');

      const streamed = spawnSync('zip', ['-q', '-', 'manifest.json', 'background.js'], { cwd: dir, maxBuffer: 1 << 20 });
      assert.ok(streamed.stdout.readUInt16LE(6) & 0x08, 'expected a data descriptor flag');
      assert.equal(readManifest(streamed.stdout).version, '3.1.4');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
