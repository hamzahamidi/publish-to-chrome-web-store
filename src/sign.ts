import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';
import { ActionError } from './errors.ts';

const SIGNATURE_CONTEXT = Buffer.from('CRX3 SignedData\x00', 'latin1');

export interface SignedCrx {
  crx: Buffer;
  crxId: string;
}

export function packCrx(archive: Buffer, privateKeyPem: string): SignedCrx {
  let key: KeyObject;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    if (/-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type:\s*4,ENCRYPTED/.test(privateKeyPem)) {
      throw new ActionError('The private key is encrypted. Pass it unencrypted, for example the output of `openssl pkey -in key.pem`.');
    }
    throw new ActionError('The private key is not a PEM private key.');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new ActionError(`The private key is ${key.asymmetricKeyType ?? 'not RSA'}, and the Chrome Web Store needs an RSA key.`);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const crxIdBytes = createHash('sha256').update(publicKey).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxIdBytes);
  const signature = sign('sha256', Buffer.concat([SIGNATURE_CONTEXT, uint32(signedHeaderData.length), signedHeaderData, archive]), key);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, publicKey), field(2, signature)])), field(10000, signedHeaderData)]);
  return {
    crx: Buffer.concat([Buffer.from('Cr24', 'latin1'), uint32(3), uint32(header.length), header, archive]),
    crxId: [...crxIdBytes.toString('hex')].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join(''),
  };
}

function field(number: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function uint32(value: number): Buffer {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}
