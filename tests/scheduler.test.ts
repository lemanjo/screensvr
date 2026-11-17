import { describe, expect, it } from "vitest";
import { resolveSchedule } from "../src/server/scheduler.js";
import { scheduleSchema, type ScheduleEntry } from "../src/shared/scenes.js";

const all = [1, 2, 3, 4, 5, 6, 7];
const routine: ScheduleEntry[] = [
  { days: [1, 2, 3, 4, 5], time: "07:00", sceneId: "photos" },
  { days: [6, 7], time: "09:00", sceneId: "photos" },
  { days: all, time: "19:00", sceneId: "evening" },
  { days: all, time: "23:00", sceneId: "night" },
];
function resolve(at: string, entries = routine, timezone = "UTC") {
  return resolveSchedule(entries, timezone, Date.parse(at));
}

describe("weekly schedule resolution", () => {
  it("uses weekdays, exact boundaries, overnight carryover, and week wraparound", () => {
    expect(resolve("2026-11-16T06:59:59Z").current?.sceneId).toBe("night");
    expect(resolve("2026-11-16T07:00:00Z").current?.sceneId).toBe("photos");
    expect(resolve("2026-11-21T08:00:00Z").current?.sceneId).toBe("night");
    expect(resolve("2026-11-21T09:00:00Z").current?.sceneId).toBe("photos");
    expect(resolve("2026-11-22T23:59:00Z").next).toMatchObject({
      sceneId: "photos",
      at: Date.parse("2026-11-23T07:00:00Z"),
    });
  });
  it("carries scenes across days without entries and resolves directly after downtime", () => {
    const entries = [{ days: [1], time: "07:00", sceneId: "weekly" }];
    expect(resolve("2026-11-16T06:00:00Z", entries).current?.at).toBe(
      Date.parse("2026-11-09T07:00:00Z"),
    );
    expect(resolve("2026-11-20T12:00:00Z", entries).current?.sceneId).toBe(
      "weekly",
    );
  });
  it("uses the display timezone, including non-hour offsets", () => {
    expect(
      resolve("2026-11-16T01:15:00Z", routine, "Asia/Kathmandu").current
        ?.sceneId,
    ).toBe("photos");
    expect(
      resolve("2026-11-16T04:59:00Z", routine, "Europe/Helsinki").current
        ?.sceneId,
    ).toBe("night");
    expect(
      resolve("2026-11-16T05:00:00Z", routine, "Europe/Helsinki").current
        ?.sceneId,
    ).toBe("photos");
  });
  it("applies skipped spring entries at the jump with the latest wall time winning", () => {
    const entries = [
      { days: all, time: "00:00", sceneId: "night" },
      { days: all, time: "02:00", sceneId: "early" },
      { days: all, time: "02:30", sceneId: "later" },
      { days: all, time: "04:00", sceneId: "day" },
    ];
    expect(
      resolve("2026-03-08T06:59:59Z", entries, "America/New_York").next,
    ).toMatchObject({
      at: Date.parse("2026-03-08T07:00:00Z"),
      sceneId: "later",
    });
    expect(
      resolve("2026-03-08T07:00:00Z", entries, "America/New_York").current
        ?.sceneId,
    ).toBe("later");
    const withValid = [
      ...entries,
      { days: all, time: "03:00", sceneId: "valid" },
    ];
    expect(
      resolve("2026-03-08T07:00:00Z", withValid, "America/New_York").current
        ?.sceneId,
    ).toBe("valid");
  });
  it("does not revert or refire entries during a repeated autumn hour", () => {
    const entries = [
      { days: all, time: "00:00", sceneId: "night" },
      { days: all, time: "01:30", sceneId: "first" },
      { days: all, time: "01:45", sceneId: "second" },
    ];
    expect(
      resolve("2026-11-01T05:30:00Z", entries, "America/New_York").current
        ?.sceneId,
    ).toBe("first");
    const repeated = resolve(
      "2026-11-01T06:10:00Z",
      entries,
      "America/New_York",
    );
    expect(repeated.current?.sceneId).toBe("second");
    expect(repeated.next?.at).toBe(Date.parse("2026-11-02T05:00:00Z"));
  });
  it("handles a half-hour daylight-saving gap", () => {
    const entries = [
      { days: all, time: "00:00", sceneId: "night" },
      { days: all, time: "02:10", sceneId: "day" },
    ];
    expect(
      resolve("2026-10-03T15:30:00Z", entries, "Australia/Lord_Howe").current,
    ).toMatchObject({ sceneId: "day", at: Date.parse("2026-10-03T15:30:00Z") });
  });
});

it("validates schedule bounds, conflicts, weekdays, and enabling an empty schedule", () => {
  expect(
    scheduleSchema.safeParse({ enabled: false, entries: [] }).success,
  ).toBe(true);
  for (const value of [
    { enabled: true, entries: [] },
    { enabled: true, entries: [{ days: [], time: "07:00", sceneId: "a" }] },
    { enabled: true, entries: [{ days: [0], time: "07:00", sceneId: "a" }] },
    { enabled: true, entries: [{ days: [1, 1], time: "07:00", sceneId: "a" }] },
    { enabled: true, entries: [{ days: [1], time: "24:00", sceneId: "a" }] },
    {
      enabled: true,
      entries: [
        { days: [1, 2], time: "07:00", sceneId: "a" },
        { days: [2], time: "07:00", sceneId: "b" },
      ],
    },
  ])
    expect(scheduleSchema.safeParse(value).success).toBe(false);
});
