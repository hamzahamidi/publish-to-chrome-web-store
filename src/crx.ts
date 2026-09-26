import { ActionError } from './errors.ts';

const CRX_MAGIC = 'Cr24';
const CRX_DIFF_MAGIC = 'CrOD';
const CRX3_PREFIX_BYTES = 12;
const MAX_HEADER_BYTES = 256 * 1024;

export function isCrx(file: Buffer): boolean {
  return file.length >= 4 && [CRX_MAGIC, CRX_DIFF_MAGIC].includes(file.toString('latin1', 0, 4));
}

export function crxArchive(crx: Buffer, label: string): Buffer {
  if (crx.length >= 4 && crx.toString('latin1', 0, 4) === CRX_DIFF_MAGIC) {
    throw new ActionError(`${label} is a differential CRX, not a full package. Upload the full CRX that Chrome's packer or a CRX3 packer writes.`);
  }
  if (!isCrx(crx)) throw new ActionError(`${label} is not a CRX package. Pass a ZIP through the zip input instead.`);
  if (crx.length < CRX3_PREFIX_BYTES) throw new ActionError(`${label} is truncated.`);
  const version = crx.readUInt32LE(4);
  if (version === 2) {
    throw new ActionError(`${label} is a CRX2 package. The Chrome Web Store needs CRX3, which current Chrome and CRX3 packers produce.`);
  }
  if (version !== 3) throw new ActionError(`${label} declares CRX format version ${version}, which is not supported.`);
  const headerSize = crx.readUInt32LE(8);
  const archiveStart = CRX3_PREFIX_BYTES + headerSize;
  if (headerSize === 0 || headerSize > MAX_HEADER_BYTES || archiveStart >= crx.length) {
    throw new ActionError(`${label} has a damaged CRX header (header length ${headerSize} in a ${crx.length} byte file).`);
  }
  return crx.subarray(archiveStart);
}
