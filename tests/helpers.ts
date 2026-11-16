import { crc32, deflateRawSync } from "node:zlib";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { FaceManifest } from "../src/shared/contracts.js";

export async function temporaryDirectory(prefix: string) {
  try {
    return await mkdtemp(`/tmp/opencode/${prefix}`);
  } catch {
    return mkdtemp(path.join(tmpdir(), prefix));
  }
}

export const testManifest: FaceManifest = {
  schemaVersion: 1,
  id: "test-face",
  version: "1.0.0",
  entry: "index.html",
  name: "Test Face",
  description: "An independently packaged face.",
  author: "Test",
  settings: [
    {
      key: "caption",
      label: "Caption",
      type: "text",
      default: "Hello, quiet world.",
    },
    {
      key: "size",
      label: "Text size",
      type: "number",
      default: 24,
      min: 10,
      max: 80,
    },
  ],
};

type ZipEntry = {
  name: string;
  data: string | Buffer;
  mode?: number;
  deflate?: boolean;
};
export function zip(entries: ZipEntry[]) {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data);
    const packed = entry.deflate ? deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(packed.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    chunks.push(local, name, packed);
    central.push(record, name);
    offset += local.length + name.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

export function faceZip(manifest: unknown = testManifest) {
  return zip([
    { name: "manifest.json", data: JSON.stringify(manifest) },
    {
      name: "index.html",
      data: '<!doctype html><html><body><p id="caption"></p><script src="/face-sdk.js"></script><script type="module" src="face.js"></script></body></html>',
    },
    {
      name: "face.js",
      data: 'import { target } from "./target.js"; window.screensvr.onUpdate(({config}) => {document.getElementById(target).textContent = config.caption;});',
    },
    { name: "target.js", data: 'export const target = "caption";' },
  ]);
}

export async function administrator(app: FastifyInstance) {
  const setup = await app.inject({
    method: "POST",
    url: "/api/auth/setup",
    payload: { password: "a-long-test-password" },
  });
  const cookie = setup.cookies.find(
    (cookie) => cookie.name === "screensvr_admin",
  )!;
  return {
    cookie: `${cookie.name}=${cookie.value}`,
    "x-csrf-token": setup.json().csrf as string,
  };
}

export function upload(
  app: FastifyInstance,
  headers: Record<string, string>,
  data: Buffer,
) {
  const boundary = "screensvr-test-boundary";
  return app.inject({
    method: "POST",
    url: "/api/faces",
    headers: {
      ...headers,
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="package"; filename="face.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      data,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  });
}
