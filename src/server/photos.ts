import { randomBytes } from "node:crypto";
import sharp from "sharp";
import type { Bindings, PhotoValue } from "../shared/face-data.js";
import type { Store } from "./db.js";
import { UserError } from "./faces.js";
import type { MountedFolder } from "./integrations/mounted-folder.js";

export type PhotoScope = {
  deviceId: string;
  revision: number;
  preview?: boolean;
};
type Grant = {
  key: string;
  scope: PhotoScope;
  inputKey: string;
  binding: Bindings[string];
  integrationRevision: number;
  expires: number;
};
const sizes = [320, 640, 1280, 1920, 2560];
const bucket = (size: number) => sizes.find((value) => value >= size)!;

export class Photos {
  private grants = new Map<string, Grant>();
  private keys = new Map<string, string>();
  private cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private active = 0;
  constructor(
    private store: Store,
    private client: (id: string) => MountedFolder | undefined,
  ) {}
  grant(
    value: PhotoValue,
    binding: Bindings[string],
    inputKey: string,
    scope: PhotoScope,
  ): PhotoValue {
    const row = this.store.integration(binding.integrationId)!;
    const key = JSON.stringify([scope, inputKey, binding, row.revision]);
    let token = this.keys.get(key);
    const existing = token && this.grants.get(token);
    if (!existing || existing.expires < Date.now() + 60000) {
      for (const [id, grant] of this.grants)
        if (grant.expires <= Date.now() || this.grants.size >= 2048) {
          this.grants.delete(id);
          if (this.keys.get(grant.key) === id) this.keys.delete(grant.key);
        }
      token = randomBytes(24).toString("base64url");
      this.grants.set(token, {
        key,
        scope,
        inputKey,
        binding,
        integrationRevision: row.revision,
        expires: Date.now() + 10 * 60000,
      });
      this.keys.set(key, token);
    }
    return { ...value, url: `/api/photos/${token}` };
  }
  private authorized(token: string) {
    const grant = this.grants.get(token);
    if (!grant || grant.expires <= Date.now()) return;
    const row = this.store.integration(grant.binding.integrationId);
    const device = this.store.device(grant.scope.deviceId);
    if (
      !row?.enabled ||
      row.revision !== grant.integrationRevision ||
      !device ||
      device.revision !== grant.scope.revision
    )
      return;
    if (!grant.scope.preview) {
      const binding = this.store.bindings(device.id)[grant.inputKey];
      if (
        binding?.integrationId !== grant.binding.integrationId ||
        binding.sourceId !== grant.binding.sourceId
      )
        return;
    }
    return grant;
  }
  async image(token: string, index: number, width: number, height: number) {
    const grant = this.authorized(token);
    const client = grant && this.client(grant.binding.integrationId);
    if (!grant || !client) throw new UserError("Photo unavailable.", 404);
    if (this.active >= 4)
      throw new UserError("Too many photo requests. Try again shortly.", 429);
    this.active++;
    try {
      const photo = await client.read(grant.binding.sourceId, index);
      try {
        const key = `${grant.binding.integrationId}:${grant.integrationRevision}:${photo.key}:${bucket(width)}:${bucket(height)}`;
        let bytes = this.cache.get(key);
        if (bytes) {
          this.cache.delete(key);
          this.cache.set(key, bytes);
        } else {
          const original = await photo.load();
          const jpeg = original
            .subarray(0, 3)
            .equals(Buffer.from([0xff, 0xd8, 0xff]));
          const png = original
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
          const webp =
            original.toString("ascii", 0, 4) === "RIFF" &&
            original.toString("ascii", 8, 12) === "WEBP";
          if (!jpeg && !png && !webp) throw new Error();
          const image = sharp(original, {
            limitInputPixels: 40000000,
            animated: false,
            failOn: "warning",
          });
          const metadata = await image.metadata();
          if (!["jpeg", "png", "webp"].includes(metadata.format ?? ""))
            throw new Error();
          bytes = await image
            .rotate()
            .resize(bucket(width), bucket(height), {
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({ quality: 85 })
            .toBuffer();
          while (
            this.cache.size &&
            (this.cacheBytes + bytes.length > 32 * 1024 * 1024 ||
              this.cache.size >= 128)
          ) {
            const oldest = this.cache.keys().next().value!;
            this.cacheBytes -= this.cache.get(oldest)!.length;
            this.cache.delete(oldest);
          }
          if (bytes.length <= 32 * 1024 * 1024) {
            // Concurrent requests for one variant must not double-count the cache.
            this.cacheBytes -= this.cache.get(key)?.length ?? 0;
            this.cache.set(key, bytes);
            this.cacheBytes += bytes.length;
          }
        }
        // Revocation during a filesystem read/resize also takes effect.
        if (!this.authorized(token)) throw new Error();
        return bytes;
      } finally {
        await photo.close();
      }
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError("Photo unavailable or unsupported.", 404);
    } finally {
      this.active--;
    }
  }
  close() {
    this.grants.clear();
    this.keys.clear();
    this.cache.clear();
    this.cacheBytes = 0;
  }
}
