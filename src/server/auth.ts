import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Store } from "./db.js";

const derive = promisify(scrypt);
export const secret = () => randomBytes(32).toString("hex");
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  const key = (await derive(password, salt, 64)) as Buffer;
  return `${salt}:${key.toString("hex")}`;
}

export async function passwordMatches(password: string, stored: string) {
  const [salt, expected] = stored.split(":");
  const actual = (await derive(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, "hex"));
}

export function auth(store: Store, secure: boolean) {
  function session(request: FastifyRequest) {
    const token = request.cookies.screensvr_admin;
    if (!token || token.length !== 64) return undefined;
    return store.db
      .prepare("SELECT csrf FROM sessions WHERE hash = ? AND expires > ?")
      .get(hash(token), Date.now()) as { csrf: string } | undefined;
  }
  async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    const current = session(request);
    if (!current)
      return reply.code(401).send({ error: "Sign in to continue." });
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers["x-csrf-token"] !== current.csrf
    ) {
      return reply
        .code(403)
        .send({ error: "Invalid request token. Refresh and try again." });
    }
  }
  function startSession(reply: FastifyReply) {
    const token = secret();
    const csrf = secret();
    store.db.prepare("DELETE FROM sessions WHERE expires <= ?").run(Date.now());
    store.db
      .prepare("INSERT INTO sessions VALUES (?, ?, ?)")
      .run(hash(token), csrf, Date.now() + 7 * 86400000);
    reply.setCookie("screensvr_admin", token, {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
      maxAge: 7 * 86400,
    });
    return csrf;
  }
  return { session, requireAdmin, startSession };
}
