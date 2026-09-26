import { crc32, inflateRawSync } from 'node:zlib';
import { ActionError } from './errors.ts';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const VERSION_PATTERN = /^(0|[1-9]\d{0,4})(\.(0|[1-9]\d{0,4})){0,3}$/;

interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

export interface Manifest {
  version: string;
  manifest: Record<string, unknown>;
}

export function isExtensionVersion(version: unknown): version is string {
  return typeof version === 'string' && VERSION_PATTERN.test(version) && version.split('.').every((part) => Number(part) <= 65535);
}

export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function readManifest(zip: Buffer, label = 'the ZIP'): Manifest {
  if (zip.length >= 4 && zip.toString('latin1', 0, 4) === 'Cr24') {
    throw new ActionError(`${label} is a CRX package, not a ZIP.`);
  }
  const entries = centralDirectory(zip, label);
  const matches = entries.filter((entry) => entry.name === 'manifest.json');
  if (matches.length === 0) {
    const nested = entries.find((entry) => entry.name.endsWith('/manifest.json'));
    throw new ActionError(
      nested
        ? `${label} has no manifest.json at its root, only ${JSON.stringify(nested.name)}. Zip the contents of the extension folder, not the folder itself.`
        : `${label} has no manifest.json at its root.`,
    );
  }
  if (matches.length > 1) throw new ActionError(`${label} contains manifest.json more than once.`);

  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(extract(zip, matches[0]!, label).toString('utf8').replace(/^﻿/, '')) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ActionError) throw error;
    throw new ActionError(`manifest.json in ${label} is not valid JSON: ${(error as Error).message}`);
  }
  const version = manifest?.version;
  if (!isExtensionVersion(version)) {
    throw new ActionError(`manifest.json in ${label} has version ${JSON.stringify(version)}, which is not a valid extension version.`);
  }
  return { version, manifest };
}

function centralDirectory(zip: Buffer, label: string): ZipEntry[] {
  const end = findEndOfCentralDirectory(zip, label);
  const count = zip.readUInt16LE(end + 10);
  const size = zip.readUInt32LE(end + 12);
  const start = zip.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || start === 0xffffffff) {
    throw new ActionError(`${label} is a ZIP64 archive, which is not supported.`);
  }
  if (start + size > end) throw new ActionError(`${label} is not a valid ZIP file (central directory out of range).`);

  const entries: ZipEntry[] = [];
  let offset = start;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > end || zip.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new ActionError(`${label} is not a valid ZIP file (damaged central directory).`);
    }
    const nameLength = zip.readUInt16LE(offset + 28);
    entries.push({
      flags: zip.readUInt16LE(offset + 8),
      method: zip.readUInt16LE(offset + 10),
      crc: zip.readUInt32LE(offset + 16),
      compressedSize: zip.readUInt32LE(offset + 20),
      size: zip.readUInt32LE(offset + 24),
      localOffset: zip.readUInt32LE(offset + 42),
      name: zip.toString('utf8', offset + 46, offset + 46 + nameLength),
    });
    offset += 46 + nameLength + zip.readUInt16LE(offset + 30) + zip.readUInt16LE(offset + 32);
  }
  return entries;
}

function findEndOfCentralDirectory(zip: Buffer, label: string): number {
  const lowest = Math.max(0, zip.length - 22 - 0xffff);
  for (let offset = zip.length - 22; offset >= lowest; offset--) {
    if (zip.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ActionError(`${label} is not a valid ZIP file.`);
}

function extract(zip: Buffer, entry: ZipEntry, label: string): Buffer {
  if (entry.flags & 1) throw new ActionError(`manifest.json in ${label} is encrypted.`);
  if (entry.size > MAX_MANIFEST_BYTES) throw new ActionError(`manifest.json in ${label} is larger than 1 MiB.`);
  const header = entry.localOffset;
  if (header + 30 > zip.length || zip.readUInt32LE(header) !== LOCAL_FILE_HEADER) {
    throw new ActionError(`${label} is not a valid ZIP file (damaged entry for manifest.json).`);
  }
  const dataStart = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28);
  const data = zip.subarray(dataStart, dataStart + entry.compressedSize);
  if (data.length !== entry.compressedSize) throw new ActionError(`${label} is truncated.`);

  let content: Buffer;
  if (entry.method === 0) content = data;
  else if (entry.method === 8) {
    try {
      content = inflateRawSync(data, { maxOutputLength: MAX_MANIFEST_BYTES });
    } catch {
      throw new ActionError(`manifest.json in ${label} could not be decompressed.`);
    }
  } else throw new ActionError(`manifest.json in ${label} uses ZIP compression method ${entry.method}, which is not supported.`);

  if (content.length !== entry.size || crc32(content) !== entry.crc) {
    throw new ActionError(`manifest.json in ${label} fails its checksum. The ZIP is damaged.`);
  }
  return content;
}
