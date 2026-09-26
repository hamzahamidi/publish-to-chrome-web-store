import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { crxArchive, isCrx } from '../src/crx.ts';
import { ActionError } from '../src/errors.ts';
import { readManifest } from '../src/zip.ts';
import { extensionZip, makeCrx } from './helpers.ts';

function fails(crx: Buffer, pattern: RegExp) {
  assert.throws(
    () => crxArchive(crx, 'ext.crx'),
    (error) => error instanceof ActionError && pattern.test(error.message),
  );
}

describe('crxArchive', () => {
  it('returns the ZIP inside a CRX3 package, so the manifest version can be read', () => {
    const archive = crxArchive(makeCrx(extensionZip('2.3.4')), 'ext.crx');
    assert.equal(readManifest(archive).version, '2.3.4');
  });

  it('reads a CRX written by Chrome for Testing 153 with --pack-extension', () => {
    const crx = readFileSync(new URL('./fixtures/chromium-packed.crx', import.meta.url));
    assert.equal(readManifest(crxArchive(crx, 'chromium-packed.crx')).version, '1.2.3');
  });

  it('recognises the CRX magic', () => {
    assert.equal(isCrx(makeCrx(extensionZip('1.0'))), true);
    assert.equal(isCrx(extensionZip('1.0')), false);
  });

  it('refuses a ZIP passed as a CRX', () => {
    fails(extensionZip('1.0'), /is not a CRX package\. Pass a ZIP through the zip input instead\./);
  });

  it('refuses CRX2, which the store no longer accepts', () => {
    fails(makeCrx(extensionZip('1.0'), { version: 2 }), /is a CRX2 package\. The Chrome Web Store needs CRX3/);
  });

  it('refuses a differential CRX', () => {
    const diff = makeCrx(extensionZip('1.0'));
    diff.write('CrOD', 0, 'latin1');
    fails(diff, /is a differential CRX, not a full package/);
  });

  it('refuses an unknown format version', () => {
    fails(makeCrx(extensionZip('1.0'), { version: 4 }), /declares CRX format version 4/);
  });

  it('refuses a header length that is zero, too large or past the end of the file', () => {
    fails(makeCrx(extensionZip('1.0'), { header: Buffer.alloc(0) }), /damaged CRX header \(header length 0/);
    const huge = makeCrx(extensionZip('1.0'));
    huge.writeUInt32LE(256 * 1024 + 1, 8);
    fails(huge, /damaged CRX header/);
    const past = makeCrx(extensionZip('1.0'));
    past.writeUInt32LE(past.length, 8);
    fails(past, /damaged CRX header/);
  });

  it('refuses a truncated file', () => {
    fails(Buffer.from('Cr24\x03\x00'), /is truncated/);
  });
});
