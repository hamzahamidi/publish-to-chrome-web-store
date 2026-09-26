import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { crc32, deflateRawSync } from 'node:zlib';

export interface ZipFile {
  name: string;
  data: string;
  method?: number;
  flags?: number;
  crc?: number;
}

export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name);
    const data = Buffer.from(file.data);
    const method = file.method ?? 8;
    const packed = method === 8 ? deflateRawSync(data) : data;
    const flags = file.flags ?? 0x0800;
    const crc = file.crc ?? crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, packed);
    centrals.push(central, name);
    offset += 30 + name.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export function extensionZip(version: string, { method }: { method?: number } = {}): Buffer {
  return makeZip([
    { name: 'manifest.json', data: JSON.stringify({ manifest_version: 3, name: 'Test extension', version }), method },
    { name: 'background.js', data: 'chrome.runtime.onInstalled.addListener(() => {});\n', method },
  ]);
}

export function makeCrx(archive: Buffer, { version = 3, header = Buffer.from('signed header bytes') }: { version?: number; header?: Buffer } = {}): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.write('Cr24', 0, 'latin1');
  prefix.writeUInt32LE(version, 4);
  prefix.writeUInt32LE(header.length, 8);
  return Buffer.concat([prefix, header, archive]);
}

export const PUBLISHER = 'pub-1';
export const ITEM = 'abcdefghijklmnopabcdefghijklmnop';
export const ITEM_PATH = `/publishers/${PUBLISHER}/items/${ITEM}`;
export const FETCH = `GET /v2${ITEM_PATH}:fetchStatus`;
export const UPLOAD = `POST /upload/v2${ITEM_PATH}:upload`;
export const PUBLISH = `POST /v2${ITEM_PATH}:publish`;

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
  partial?: boolean;
}

export interface RecordedRequest {
  key: string;
  auth: string | undefined;
  contentType: string | undefined;
  uploadProtocol: string | undefined;
  uploadFileName: string | undefined;
  size: number;
  body: string;
}

export interface MockStore {
  base: string;
  requests: RecordedRequest[];
  on(key: string, ...replies: Reply[]): void;
  reset(): void;
  close(): Promise<void>;
}

interface StatusOptions {
  published?: string;
  submitted?: string;
  submittedState?: string;
  lastAsyncUploadState?: string;
  takenDown?: boolean;
  warned?: boolean;
}

export function storeStatus({ published, submitted, submittedState = 'PENDING_REVIEW', lastAsyncUploadState, takenDown, warned }: StatusOptions = {}): Reply {
  const channels = (version: string | undefined) => (version ? [{ deployPercentage: 100, crxVersion: version }] : []);
  return {
    body: {
      name: ITEM_PATH.slice(1),
      itemId: ITEM,
      ...(published ? { publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: channels(published) } } : {}),
      ...(submitted ? { submittedItemRevisionStatus: { state: submittedState, distributionChannels: channels(submitted) } } : {}),
      ...(lastAsyncUploadState ? { lastAsyncUploadState } : {}),
      ...(takenDown === undefined ? {} : { takenDown }),
      ...(warned === undefined ? {} : { warned }),
    },
  };
}

export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

export async function startMockStore({ onRequest }: { onRequest?: (request: RecordedRequest, requests: RecordedRequest[]) => void } = {}): Promise<MockStore> {
  const routes = new Map<string, Reply[]>();
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const payload = Buffer.concat(chunks);
      const key = `${req.method} ${req.url}`;
      const request: RecordedRequest = {
        key,
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        uploadProtocol: req.headers['x-goog-upload-protocol'] as string | undefined,
        uploadFileName: req.headers['x-goog-upload-file-name'] as string | undefined,
        size: payload.length,
        body: payload.toString(),
      };
      requests.push(request);
      onRequest?.(request, requests);
      const queue = routes.get(key);
      const reply: Reply = (queue && (queue.length > 1 ? queue.shift() : queue[0])) ?? { status: 404, body: { error: { code: 404, message: `no mock route for ${key}` } } };
      if (reply.partial) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
        res.write('{"sta');
        setTimeout(() => res.socket?.destroy(), 20);
        return;
      }
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    on(key, ...replies) {
      routes.set(key, replies);
    },
    reset() {
      routes.clear();
      requests.length = 0;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
