import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { validateSettings } from "../shared/contracts.js";
import { bindingsSchema } from "../shared/face-data.js";
import { scheduleSchema, type SceneConfiguration } from "../shared/scenes.js";
import type { auth } from "./auth.js";
import type { Store } from "./db.js";
import { UserError } from "./faces.js";
import type { Integrations } from "./integrations/manager.js";

const revision = z.number().int().positive();
const name = z.string().trim().min(1).max(80);
const fields = {
  revision,
  name: name.optional(),
  faceId: z.string().min(1).max(64).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  bindings: bindingsSchema.optional(),
};
const create = z
  .object({ ...fields, name, copyFrom: z.string().max(64).optional() })
  .strict();
const edit = z.object(fields).strict();
const expected = z.object({ revision }).strict();
const scheduleBody = z.object({ revision, schedule: scheduleSchema }).strict();

export function sceneConfiguration(
  store: Store,
  id: string,
): SceneConfiguration {
  const device = store.device(id);
  if (!device) throw new UserError("Display not found.", 404);
  const selection = store.selection(id)!;
  return {
    revision: device.revision,
    scenes: store.scenes(id),
    schedule: store.schedule(id),
    activeSceneId: selection.sceneId,
    nextTransition: selection.next,
  };
}

export function sceneRoutes(
  app: FastifyInstance,
  store: Store,
  integrations: Integrations,
  security: Pick<ReturnType<typeof auth>, "requireAdmin">,
  changed: (id: string) => void,
) {
  const admin = { preHandler: security.requireAdmin };
  function check(id: string, revision: number) {
    const device = store.device(id);
    if (!device) throw new UserError("Display not found.", 404);
    if (device.revision !== revision)
      throw new UserError(
        "This display changed elsewhere. Reload its settings and try again.",
        409,
      );
    return device;
  }
  function scene(id: string, sceneId: string) {
    const saved = store.scene(id, sceneId);
    if (!saved) throw new UserError("Scene not found on this display.", 404);
    return saved;
  }
  function settings(faceId: string, input: unknown) {
    const face = store.face(faceId);
    if (!face) throw new UserError("Face not found.", 404);
    try {
      return { face, values: validateSettings(face.manifest, input) };
    } catch (error) {
      throw new UserError((error as Error).message);
    }
  }
  function commit(id: string, revision: number, write: () => void) {
    check(id, revision);
    store.db.exec("BEGIN;");
    try {
      write();
      store.db
        .prepare("UPDATE devices SET revision = revision + 1 WHERE id = ?")
        .run(id);
      store.db.exec("COMMIT;");
    } catch (error) {
      store.db.exec("ROLLBACK;");
      throw error;
    }
    changed(id);
    return sceneConfiguration(store, id);
  }

  app.get<{ Params: { id: string } }>(
    "/api/devices/:id/scenes",
    admin,
    async (request) => sceneConfiguration(store, request.params.id),
  );
  app.post<{ Params: { id: string } }>(
    "/api/devices/:id/scenes",
    admin,
    async (request, reply) => {
      const input = create.parse(request.body);
      const id = request.params.id;
      check(id, input.revision);
      if (store.scenes(id).length >= 32)
        throw new UserError("At most 32 scenes can be saved per display.");
      const source = input.copyFrom ? scene(id, input.copyFrom) : undefined;
      const faceId = input.faceId ?? source?.faceId;
      if (!faceId) throw new UserError("Choose a face for this scene.");
      const sameFace = source?.faceId === faceId;
      const { face, values } = settings(
        faceId,
        input.settings ?? (sameFace ? source.settings : {}),
      );
      const sceneId = randomUUID();
      const bindings = await integrations.validate(
        face.manifest,
        input.bindings ?? (sameFace ? source.bindings : {}),
        sameFace ? source.bindings : {},
        undefined,
        sceneId,
      );
      const result = commit(id, input.revision, () => {
        store.db
          .prepare("INSERT INTO scenes VALUES (?, ?, ?, ?, ?)")
          .run(sceneId, id, input.name, faceId, JSON.stringify(values));
        store.replaceSceneBindings(sceneId, bindings);
        integrations.checkLimits(bindings, undefined, sceneId);
      });
      return reply.code(201).send({ ...result, createdSceneId: sceneId });
    },
  );
  app.patch<{ Params: { id: string; sceneId: string } }>(
    "/api/devices/:id/scenes/:sceneId",
    admin,
    async (request) => {
      const input = edit.parse(request.body);
      const { id, sceneId } = request.params;
      check(id, input.revision);
      const current = scene(id, sceneId);
      const faceId = input.faceId ?? current.faceId;
      const sameFace = faceId === current.faceId;
      const { face, values } = settings(
        faceId,
        input.settings ?? (sameFace ? current.settings : {}),
      );
      const bindings = await integrations.validate(
        face.manifest,
        input.bindings ?? (sameFace ? current.bindings : {}),
        sameFace ? current.bindings : {},
        undefined,
        sceneId,
      );
      return commit(id, input.revision, () => {
        store.db
          .prepare(
            "UPDATE scenes SET name = ?, face_id = ?, settings = ? WHERE id = ?",
          )
          .run(
            input.name ?? current.name,
            faceId,
            JSON.stringify(values),
            sceneId,
          );
        store.replaceSceneBindings(sceneId, bindings);
        integrations.checkLimits(bindings, undefined, sceneId);
      });
    },
  );
  app.delete<{ Params: { id: string; sceneId: string } }>(
    "/api/devices/:id/scenes/:sceneId",
    admin,
    async (request) => {
      const { revision } = expected.parse(request.body);
      const { id, sceneId } = request.params;
      const device = check(id, revision);
      scene(id, sceneId);
      if (store.scenes(id).length === 1)
        throw new UserError("Keep at least one scene on this display.", 409);
      if (
        device.manual_scene_id === sceneId ||
        store.db
          .prepare("SELECT 1 FROM schedule_entries WHERE scene_id = ?")
          .get(sceneId)
      )
        throw new UserError(
          "Select another manual scene and remove this scene from the schedule before deleting it.",
          409,
        );
      return commit(id, revision, () => {
        store.db
          .prepare("DELETE FROM scenes WHERE id = ? AND device_id = ?")
          .run(sceneId, id);
      });
    },
  );
  app.post<{ Params: { id: string; sceneId: string } }>(
    "/api/devices/:id/scenes/:sceneId/activate",
    admin,
    async (request) => {
      const { revision } = expected.parse(request.body);
      const { id, sceneId } = request.params;
      const device = check(id, revision);
      scene(id, sceneId);
      if (device.schedule_enabled)
        throw new UserError(
          "Disable scheduling before manually activating a scene.",
          409,
        );
      return commit(id, revision, () => {
        store.db
          .prepare("UPDATE devices SET manual_scene_id = ? WHERE id = ?")
          .run(sceneId, id);
      });
    },
  );
  app.put<{ Params: { id: string } }>(
    "/api/devices/:id/schedule",
    admin,
    async (request) => {
      const { revision, schedule } = scheduleBody.parse(request.body);
      const id = request.params.id;
      const device = check(id, revision);
      for (const entry of schedule.entries) scene(id, entry.sceneId);
      const active = store.selection(id)!.sceneId;
      return commit(id, revision, () => {
        if (device.schedule_enabled && !schedule.enabled)
          store.db
            .prepare("UPDATE devices SET manual_scene_id = ? WHERE id = ?")
            .run(active, id);
        store.replaceSchedule(id, schedule);
      });
    },
  );
}
