import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { bindingsSchema } from "../../shared/face-data.js";
import type { auth } from "../auth.js";
import type { Store } from "../db.js";
import { UserError } from "../faces.js";
import type { Integrations } from "./manager.js";
import { baseUrl, immichUrl } from "./network.js";
import { folderSchema } from "./mounted-folder.js";
import { calendarTimezone, feedUrl } from "./calendar-http.js";

const name = z.string().trim().min(1).max(80);
const rawUrl = z.string().max(2048);
const url = rawUrl.transform((value) => baseUrl(value));
const immichBaseUrl = rawUrl.transform(immichUrl);
const calendarFeedUrl = z.string().min(1).max(2048).transform(feedUrl);
const calendarZone = z.string().min(1).max(100).transform(calendarTimezone);
const token = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^\S+$/, "Enter a token without whitespace.");
const createHomeAssistant = z
  .object({
    type: z.literal("home-assistant"),
    name,
    baseUrl: url,
    token,
    enabled: z.boolean().optional(),
  })
  .strict();
const create = z.discriminatedUnion("type", [
  createHomeAssistant,
  z
    .object({
      type: z.literal("ical"),
      name,
      feedUrl: calendarFeedUrl,
      timezone: calendarZone,
      enabled: z.boolean().optional(),
    })
    .strict(),
  createHomeAssistant.extend({
    type: z.literal("immich"),
    baseUrl: immichBaseUrl,
  }),
  z
    .object({
      type: z.literal("mounted-folder"),
      name,
      folder: folderSchema.default(""),
      enabled: z.boolean().optional(),
    })
    .strict(),
]);
const edit = z
  .object({
    revision: z.number().int().positive(),
    name: name.optional(),
    baseUrl: rawUrl.optional(),
    folder: folderSchema.optional(),
    token: token.optional(),
    enabled: z.boolean().optional(),
    feedUrl: calendarFeedUrl.optional(),
    timezone: calendarZone.optional(),
  })
  .strict();
const test = z
  .object({
    baseUrl: rawUrl.optional(),
    token: token.optional(),
    folder: folderSchema.optional(),
    feedUrl: calendarFeedUrl.optional(),
    timezone: calendarZone.optional(),
  })
  .strict();
const draft = z
  .object({
    faceId: z.string().max(64),
    bindings: bindingsSchema,
    sceneId: z.string().max(64).optional(),
  })
  .strict();

export function integrationRoutes(
  app: FastifyInstance,
  store: Store,
  integrations: Integrations,
  security: Pick<ReturnType<typeof auth>, "requireAdmin">,
) {
  const admin = { preHandler: security.requireAdmin };
  const limited = {
    ...admin,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute",
        groupId: "integration-tests",
      },
    },
  };
  const previews = {
    ...admin,
    config: {
      rateLimit: {
        max: 120,
        timeWindow: "1 minute",
        groupId: "integration-previews",
      },
    },
  };
  app.get("/api/integrations", admin, async () => integrations.list());
  app.post("/api/integrations", admin, async (request, reply) => {
    const input = create.parse(request.body);
    if (store.integrations().length >= 10)
      throw new UserError("At most 10 integrations can be configured.");
    const id = randomUUID();
    let credentials = "";
    try {
      if (input.type !== "mounted-folder")
        credentials = integrations.secrets.encrypt(
          input.type === "ical" ? input.feedUrl : input.token,
        );
    } catch {
      throw new UserError(
        "Integration key is missing or invalid. Restore integration-key from your backup.",
        503,
      );
    }
    store.db
      .prepare(
        "INSERT INTO integrations (id, type, name, base_url, credentials, enabled) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.type,
        input.name,
        input.type === "ical"
          ? input.timezone
          : input.type === "mounted-folder"
            ? input.folder
            : input.baseUrl,
        credentials,
        input.enabled === false ? 0 : 1,
      );
    integrations.reconcile();
    return reply
      .code(201)
      .send(integrations.list().find((item) => item.id === id));
  });
  app.patch<{ Params: { id: string } }>(
    "/api/integrations/:id",
    admin,
    async (request) => {
      const input = edit.parse(request.body);
      const row = store.integration(request.params.id);
      if (!row) throw new UserError("Integration not found.", 404);
      if (
        (row.type === "ical" &&
          (input.baseUrl !== undefined ||
            input.token !== undefined ||
            input.folder !== undefined)) ||
        (row.type !== "ical" &&
          (input.feedUrl !== undefined || input.timezone !== undefined))
      )
        throw new UserError(
          "These settings do not belong to this integration type.",
        );
      if (
        (row.type !== "mounted-folder" && input.folder !== undefined) ||
        (row.type === "mounted-folder" &&
          (input.baseUrl !== undefined || input.token !== undefined))
      )
        throw new UserError(
          "These settings do not belong to this integration type.",
        );
      if (input.revision !== row.revision)
        throw new UserError(
          "This integration changed elsewhere. Reload and try again.",
          409,
        );
      let credentials = row.credentials;
      if (input.token || input.feedUrl) {
        try {
          credentials = integrations.secrets.encrypt(
            (input.feedUrl ?? input.token)!,
          );
        } catch {
          throw new UserError(
            "Integration key is missing or invalid. Restore integration-key from your backup.",
            503,
          );
        }
      }
      store.db
        .prepare(
          "UPDATE integrations SET name = ?, base_url = ?, credentials = ?, enabled = ?, revision = revision + 1 WHERE id = ?",
        )
        .run(
          input.name ?? row.name,
          input.timezone ??
            input.folder ??
            (input.baseUrl === undefined
              ? row.base_url
              : row.type === "immich"
                ? immichUrl(input.baseUrl)
                : baseUrl(input.baseUrl)),
          credentials,
          input.enabled === undefined ? row.enabled : Number(input.enabled),
          row.id,
        );
      integrations.reconcile();
      return integrations.list().find((item) => item.id === row.id);
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/integrations/:id",
    admin,
    async (request) => {
      if (!store.integration(request.params.id))
        throw new UserError("Integration not found.", 404);
      const usage = store.usage(request.params.id);
      if (usage.length)
        throw new UserError(
          `Unbind or reassign this integration on: ${usage.map((item) => item.name).join(", ")}.`,
          409,
        );
      store.db
        .prepare("DELETE FROM integrations WHERE id = ?")
        .run(request.params.id);
      integrations.reconcile();
      return { ok: true };
    },
  );
  app.post("/api/integrations/test", limited, async (request) => {
    if ((request.body as { type?: string })?.type === "ical") {
      const input = z
        .object({
          type: z.literal("ical"),
          feedUrl: calendarFeedUrl,
          timezone: calendarZone,
        })
        .strict()
        .parse(request.body);
      try {
        return await integrations.calendars.test(input.feedUrl, input.timezone);
      } catch {
        throw new UserError(
          "Could not read the calendar feed. Check its direct URL, format, network, and source limits.",
          502,
        );
      }
    }
    if ((request.body as { type?: string })?.type === "mounted-folder") {
      const input = z
        .object({
          type: z.literal("mounted-folder"),
          folder: folderSchema.default(""),
        })
        .strict()
        .parse(request.body);
      return integrations.testFolder(input.folder);
    }
    if ((request.body as { type?: string })?.type === "immich") {
      const input = z
        .object({
          type: z.literal("immich"),
          baseUrl: immichBaseUrl,
          token,
        })
        .strict()
        .parse(request.body);
      return integrations.test(input.baseUrl, input.token, "immich");
    }
    const input = z
      .object({
        type: z.literal("home-assistant").optional(),
        baseUrl: url,
        token,
      })
      .strict()
      .parse(request.body);
    return integrations.test(input.baseUrl, input.token);
  });
  app.post<{ Params: { id: string } }>(
    "/api/integrations/:id/test",
    limited,
    async (request) => {
      const input = test.parse(request.body ?? {});
      const row = store.integration(request.params.id);
      if (!row) throw new UserError("Integration not found.", 404);
      if (row.type === "ical") {
        if (
          input.baseUrl !== undefined ||
          input.token !== undefined ||
          input.folder !== undefined
        )
          throw new UserError(
            "Calendar feeds use a subscription URL and timezone.",
          );
        let savedUrl: string;
        try {
          savedUrl =
            input.feedUrl ?? integrations.secrets.decrypt(row.credentials);
        } catch {
          throw new UserError(
            "Calendar URL cannot be read. Restore the matching integration-key.",
            503,
          );
        }
        let result: { ok: boolean };
        try {
          result = await integrations.calendars.test(
            savedUrl,
            input.timezone ?? row.base_url,
          );
        } catch {
          throw new UserError(
            "Could not read the calendar feed. Check its direct URL, format, network, and source limits.",
            502,
          );
        }
        if (
          !input.feedUrl &&
          (!input.timezone || input.timezone === row.base_url)
        )
          integrations.retry(row.id);
        return result;
      }
      if (input.feedUrl !== undefined || input.timezone !== undefined)
        throw new UserError(
          "These settings do not belong to this integration type.",
        );
      if (row.type === "mounted-folder") {
        if (input.baseUrl !== undefined || input.token !== undefined)
          throw new UserError("Mounted folders do not use a URL or token.");
        const result = await integrations.testFolder(
          input.folder ?? row.base_url,
        );
        if (input.folder === undefined) integrations.retry(row.id);
        return result;
      }
      if (input.folder !== undefined)
        throw new UserError("This integration does not use a folder.");
      let credential = input.token;
      if (!credential) {
        try {
          credential = integrations.secrets.decrypt(row.credentials);
        } catch {
          throw new UserError(
            "Credentials cannot be read. Restore the matching integration-key from your backup.",
            503,
          );
        }
      }
      const result = await integrations.test(
        input.baseUrl === undefined
          ? row.base_url
          : row.type === "immich"
            ? immichUrl(input.baseUrl)
            : baseUrl(input.baseUrl),
        credential,
        row.type,
      );
      if ((!input.baseUrl || input.baseUrl === row.base_url) && !input.token)
        integrations.retry(row.id);
      return result;
    },
  );
  app.get<{ Params: { id: string } }>(
    "/api/integrations/:id/sources",
    {
      ...admin,
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          groupId: "integration-discovery",
        },
      },
    },
    async (request) => {
      const query = z
        .object({
          q: z.string().max(200).default(""),
          offset: z.coerce.number().int().min(0).max(10000).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          refresh: z.enum(["true", "false"]).optional(),
          type: z
            .enum([
              "number",
              "boolean",
              "text",
              "image",
              "weather",
              "forecast",
              "calendar",
            ])
            .optional(),
          quantity: z.enum(["temperature", "humidity"]).optional(),
          period: z.enum(["daily", "hourly"]).optional(),
        })
        .strict()
        .parse(request.query);
      const sources = (
        await integrations.discover(
          request.params.id,
          query.refresh === "true",
          query.type === "calendar",
        )
      ).filter(
        (item) =>
          `${item.id} ${item.label}`
            .toLowerCase()
            .includes(query.q.toLowerCase()) &&
          (!query.type || item.type === query.type) &&
          (!query.quantity || item.quantity === query.quantity) &&
          (!query.period || item.period === query.period),
      );
      return {
        sources: sources.slice(query.offset, query.offset + query.limit),
        total: sources.length,
      };
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/devices/:id/preview",
    previews,
    async (request, reply) => {
      const input = draft.parse(request.body);
      const device = store.device(request.params.id);
      if (!device) throw new UserError("Display not found.", 404);
      const face = store.face(input.faceId);
      if (!face) throw new UserError("Face not found.", 404);
      const scene = store.scene(
        device.id,
        input.sceneId ?? store.selection(device.id)!.sceneId,
      );
      if (!scene) throw new UserError("Scene not found on this display.", 404);
      const previous = input.faceId === scene.faceId ? scene.bindings : {};
      const controller = new AbortController();
      const abort = () => {
        if (!reply.raw.writableEnded) controller.abort();
      };
      request.raw.once("aborted", abort);
      reply.raw.once("close", abort);
      try {
        const bindings = await integrations.validate(
          face.manifest,
          input.bindings,
          previous,
          device.id,
          scene.id,
        );
        return {
          data: await integrations.preview(
            face.manifest,
            bindings,
            controller.signal,
            { deviceId: device.id, revision: device.revision, preview: true },
          ),
        };
      } finally {
        request.raw.off("aborted", abort);
        reply.raw.off("close", abort);
      }
    },
  );
}
