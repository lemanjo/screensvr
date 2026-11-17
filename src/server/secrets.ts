import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

// A database-only leak must not reveal upstream tokens. A full-volume backup
// includes the key and remains sensitive.
export class Secrets {
  private key?: Buffer;
  private filename: string;
  constructor(directory: string, hasCredentials: boolean) {
    this.filename = path.join(directory, "integration-key");
    if (!existsSync(this.filename)) {
      if (hasCredentials) return;
      try {
        writeFileSync(this.filename, randomBytes(32), {
          flag: "wx",
          mode: 0o600,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    try {
      if (!lstatSync(this.filename).isFile()) return;
      chmodSync(this.filename, 0o600);
      const key = readFileSync(this.filename);
      if (key.length === 32) this.key = key;
    } catch {
      // Unreadable keys disable integrations, not otherwise independent faces.
    }
  }
  private requireKey() {
    if (!this.key)
      throw new Error(
        "Integration key is missing or invalid. Restore integration-key from your full data-directory backup.",
      );
    return this.key;
  }
  encrypt(token: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.requireKey(), nonce);
    const value = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
    return [
      "v1",
      nonce.toString("base64"),
      cipher.getAuthTag().toString("base64"),
      value.toString("base64"),
    ].join(".");
  }
  decrypt(encoded: string) {
    const key = this.requireKey();
    try {
      const [version, nonce, tag, value, extra] = encoded.split(".");
      if (version !== "v1" || extra || !nonce || !tag || !value)
        throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(nonce, "base64"),
      );
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([
        decipher.update(Buffer.from(value, "base64")),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error(
        "Integration credentials cannot be decrypted. Restore the matching integration-key or replace this connection's token.",
      );
    }
  }
}
