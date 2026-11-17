import { z } from "zod";
import type { Settings } from "./contracts.js";
import type { Bindings } from "./face-data.js";

export type Scene = {
  id: string;
  name: string;
  faceId: string;
  settings: Settings;
  bindings: Bindings;
};

export const scheduleEntrySchema = z
  .object({
    days: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time in HH:mm format."),
    sceneId: z.string().min(1).max(64),
  })
  .strict();
export const scheduleSchema = z
  .object({
    enabled: z.boolean(),
    entries: z.array(scheduleEntrySchema).max(64),
  })
  .strict()
  .superRefine((schedule, context) => {
    if (schedule.enabled && !schedule.entries.length)
      context.addIssue({
        code: "custom",
        message: "Add a schedule entry before enabling scheduling.",
      });
    const times = new Set<string>();
    for (const entry of schedule.entries) {
      for (const day of entry.days) {
        const key = `${day}/${entry.time}`;
        if (times.has(key))
          context.addIssue({
            code: "custom",
            message: "Only one scene can start at each weekday and time.",
          });
        times.add(key);
      }
    }
  });
export type Schedule = z.infer<typeof scheduleSchema>;
export type ScheduleEntry = Schedule["entries"][number];
export type SceneConfiguration = {
  revision: number;
  scenes: Scene[];
  schedule: Schedule;
  activeSceneId: string;
  nextTransition: { at: number; sceneId: string } | null;
};
