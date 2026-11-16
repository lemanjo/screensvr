import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { validateSettings } from "../shared/contracts.js";
import { auth, hash, passwordHash, passwordMatches, secret } from "./auth.js";
import { Store } from "./db.js";
import { Events } from "./events.js";
import { faceAssetRoot, Faces, UserError, ZIP_LIMIT } from "./faces.js";

const passwordBody = z
  .object({ password: z.string().min(12).max(128) })
  .strict();
const timezone = z
  .string()
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Invalid timezone.");
const name = z.string().trim().min(1).max(80);
const createDevice = z
  .object({ name, timezone, faceId: z.string().max(64) })
  .strict();
const updateDevice = z
  .object({
    revision: z.number().int().positive(),
    name: name.optional(),
    timezone: timezone.optional(),
    faceId: z.string().max(64).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
const deviceCookie = "screensvr_display";
const mime: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};
export const FACE_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

export type AppOptions = {
  dataDir: string;
  rootDir?: string;
  webDir?: string;
  secureCookies?: boolean;
  origin?: string;
  logger?: boolean;
  trustProxy?: boolean;
};

export async function createApp(options: AppOptions) {
  const root = options.rootDir ?? process.cwd();
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(options.dataDir, "screensvr.sqlite"));
  const events = new Events();
  const faces = new Faces(
    store,
    path.join(options.dataDir, "faces"),
    path.join(root, "faces"),
  );
  const app = Fastify({
    logger: options.logger
      ? { redact: ["req.headers.cookie", "req.headers.authorization"] }
      : false,
    trustProxy: options.trustProxy ?? false,
    bodyLimit: 65536,
  });
  await app.register(cookie);
  await app.register(multipart, {
    limits: { files: 1, fields: 0, fileSize: ZIP_LIMIT },
  });
  await app.register(rateLimit, { global: false });
  const security = auth(store, options.secureCookies ?? false);

  app.addHook("onRequest", async (request, reply) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      const expected =
        options.origin ?? `${request.protocol}://${request.host}`;
      if (
        (origin && origin !== expected) ||
        request.headers["sec-fetch-site"] === "cross-site"
      ) {
        return reply
          .code(403)
          .send({ error: "Cross-origin requests are not allowed." });
      }
    }
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=()",
    );
    if (!reply.hasHeader("Content-Security-Policy")) {
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
    if (!reply.hasHeader("Cache-Control"))
      reply.header("Cache-Control", "no-store");
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues.map((i) => i.message).join(" ") });
    if (error instanceof UserError)
      return reply.code(error.statusCode).send({ error: error.message });
    const code = (error as { statusCode?: number }).statusCode;
    if (code && code >= 400 && code < 500)
      return reply.code(code).send({ error: (error as Error).message });
    request.log.error(error);
    return reply
      .code(500)
      .send({ error: "Something went wrong on the server." });
  });
  app.addHook("preClose", async () => events.close());
  app.addHook("onClose", async () => store.db.close());

  app.get("/api/health", async () => ({ status: "ok", version: "0.1.0" }));
  app.get("/api/auth/status", async (request) => ({
    configured: Boolean(store.getMeta("password")),
    authenticated: Boolean(security.session(request)),
    csrf: security.session(request)?.csrf,
  }));
  const limited = {
    config: {
      rateLimit: { max: 5, timeWindow: "1 minute", groupId: "authentication" },
    },
  };
  app.post("/api/auth/setup", limited, async (request, reply) => {
    if (store.getMeta("password"))
      throw new UserError("Administrator is already configured.", 409);
    const { password } = passwordBody.parse(request.body);
    const encoded = await passwordHash(password);
    // Recheck after the asynchronous hash so concurrent setup cannot replace the administrator.
    if (store.getMeta("password"))
      throw new UserError("Administrator is already configured.", 409);
    store.db.prepare("INSERT INTO meta VALUES ('password', ?)").run(encoded);
    return { csrf: security.startSession(reply) };
  });
  app.post("/api/auth/login", limited, async (request, reply) => {
    const { password } = passwordBody.parse(request.body);
    const encoded = store.getMeta("password");
    if (!encoded || !(await passwordMatches(password, encoded)))
      throw new UserError("Incorrect password.", 401);
    return { csrf: security.startSession(reply) };
  });
  app.post(
    "/api/auth/logout",
    { preHandler: security.requireAdmin },
    async (request, reply) => {
      store.db
        .prepare("DELETE FROM sessions WHERE hash = ?")
        .run(hash(request.cookies.screensvr_admin!));
      reply.clearCookie("screensvr_admin", { path: "/" });
      return { ok: true };
    },
  );

  app.get("/api/faces", { preHandler: security.requireAdmin }, async () =>
    store.faces(),
  );
  app.post(
    "/api/faces",
    { preHandler: security.requireAdmin },
    async (request, reply) => {
      const file = await request.file();
      if (!file || !file.filename.toLowerCase().endsWith(".zip"))
        throw new UserError("Choose a face ZIP package.");
      const result = await faces.install(await file.toBuffer());
      return reply.code(201).send(result);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/faces/:id",
    { preHandler: security.requireAdmin },
    async (request) => {
      faces.remove(request.params.id);
      return { ok: true };
    },
  );

  app.get("/api/devices", { preHandler: security.requireAdmin }, async () =>
    store.devices().map((row) => ({
      id: row.id,
      name: row.name,
      timezone: row.timezone,
      revision: row.revision,
      faceId: row.face_id,
      settings: JSON.parse(row.settings),
      lastSeen: row.last_seen,
      online: events.online(row.id),
    })),
  );
  app.post(
    "/api/devices",
    { preHandler: security.requireAdmin },
    async (request, reply) => {
      const input = createDevice.parse(request.body);
      const face = store.face(input.faceId);
      if (!face) throw new UserError("Face not found.", 404);
      const id = randomUUID();
      const token = secret();
      store.db
        .prepare(
          "INSERT INTO devices (id, name, face_id, settings, timezone, token_hash) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(
          id,
          input.name,
          input.faceId,
          JSON.stringify(validateSettings(face.manifest, {})),
          input.timezone,
          hash(token),
        );
      return reply
        .code(201)
        .send({ id, displayUrl: `/display/${id}#${token}` });
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/api/devices/:id",
    { preHandler: security.requireAdmin },
    async (request) => {
      const input = updateDevice.parse(request.body);
      const current = store.device(request.params.id);
      if (!current) throw new UserError("Display not found.", 404);
      if (input.revision !== current.revision)
        throw new UserError(
          "This display changed elsewhere. Reload its settings and try again.",
          409,
        );
      const faceId = input.faceId ?? current.face_id;
      const face = store.face(faceId);
      if (!face) throw new UserError("Face not found.", 404);
      let settings;
      try {
        settings = validateSettings(
          face.manifest,
          input.settings ??
            (faceId === current.face_id ? JSON.parse(current.settings) : {}),
        );
      } catch (error) {
        throw new UserError((error as Error).message);
      }
      store.db
        .prepare(
          "UPDATE devices SET name = ?, timezone = ?, face_id = ?, settings = ?, revision = revision + 1 WHERE id = ?",
        )
        .run(
          input.name ?? current.name,
          input.timezone ?? current.timezone,
          faceId,
          JSON.stringify(settings),
          current.id,
        );
      events.publish(current.id, store);
      return store.state(current.id);
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/devices/:id/pairing",
    { preHandler: security.requireAdmin },
    async (request) => {
      const id = request.params.id;
      if (!store.device(id)) throw new UserError("Display not found.", 404);
      const token = secret();
      store.db
        .prepare("UPDATE devices SET token_hash = ? WHERE id = ?")
        .run(hash(token), id);
      events.disconnect(id);
      return { displayUrl: `/display/${id}#${token}` };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/devices/:id",
    { preHandler: security.requireAdmin },
    async (request) => {
      if (!store.device(request.params.id))
        throw new UserError("Display not found.", 404);
      events.disconnect(request.params.id);
      store.db
        .prepare("DELETE FROM devices WHERE id = ?")
        .run(request.params.id);
      return { ok: true };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/display/:id/pair",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { token } = z
        .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(request.body);
      const row = store.device(request.params.id);
      if (
        !row ||
        !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.token_hash))
      )
        throw new UserError(
          "Invalid display link. Generate a new link in management.",
          401,
        );
      reply.setCookie(deviceCookie, token, {
        httpOnly: true,
        sameSite: "strict",
        secure: options.secureCookies ?? false,
        path: `/api/display/${row.id}`,
        maxAge: 365 * 86400,
      });
      return { ok: true };
    },
  );
  function displayAuthorized(
    id: string,
    cookies: Record<string, string | undefined>,
  ) {
    const token = cookies[deviceCookie];
    const row = store.device(id);
    return (
      row &&
      token?.length === 64 &&
      timingSafeEqual(Buffer.from(hash(token)), Buffer.from(row.token_hash))
    );
  }
  app.get<{ Params: { id: string } }>(
    "/api/display/:id/state",
    async (request) => {
      if (!displayAuthorized(request.params.id, request.cookies))
        throw new UserError(
          "This screen needs pairing. Open a fresh display link from management.",
          401,
        );
      return store.state(request.params.id);
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/display/:id/events",
    async (request, reply) => {
      const id = request.params.id;
      if (!displayAuthorized(id, request.cookies))
        throw new UserError("This screen needs pairing.", 401);
      if (!events.add(id, reply.raw, store))
        throw new UserError("Too many display connections.", 429);
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      reply.raw.write("retry: 3000\n\n");
      events.publish(id, store);
    },
  );

  app.get<{ Params: { id: string; version: string; "*": string } }>(
    "/faces/:id/:version/*",
    async (request, reply) => {
      const { id, version } = request.params;
      const rootDir = faceAssetRoot(faces, id, version);
      if (!rootDir) throw new UserError("Face not found.", 404);
      const asset = request.params["*"];
      const parts = asset.split("/");
      if (
        !asset ||
        parts.some(
          (part) =>
            !part ||
            part === "." ||
            part === ".." ||
            part.includes("\\") ||
            part.includes("\0"),
        )
      )
        throw new UserError("Invalid asset path.", 400);
      const filename = path.resolve(rootDir, asset);
      if (!filename.startsWith(path.resolve(rootDir) + path.sep))
        throw new UserError("Invalid asset path.", 400);
      const contentType = mime[path.extname(filename).toLowerCase()];
      if (!contentType) throw new UserError("Unsupported asset type.", 404);
      try {
        const real = await realpath(filename);
        if (
          !real.startsWith((await realpath(rootDir)) + path.sep) ||
          !(await stat(real)).isFile()
        )
          throw new UserError("Invalid asset.", 404);
        reply.header("Content-Security-Policy", FACE_CSP);
        // Sandboxed faces have opaque origins. Anonymous module/font requests
        // need CORS, but only public face assets (never APIs) are readable.
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Cache-Control", "no-store");
        return reply.type(contentType).send(await readFile(real));
      } catch (error) {
        if (error instanceof UserError) throw error;
        throw new UserError("Face asset not found.", 404);
      }
    },
  );

  const webDir = options.webDir ?? path.join(root, "dist/web");
  if (existsSync(webDir)) {
    await app.register(staticFiles, {
      root: webDir,
      wildcard: false,
      index: false,
    });
    app.get("/", async (_request, reply) => reply.sendFile("index.html"));
    app.get("/display/:id", async (_request, reply) =>
      reply.sendFile("index.html"),
    );
  }
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "Not found." }),
  );
  return { app, store, events };
}
