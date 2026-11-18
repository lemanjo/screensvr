// Dependency-free public contract. Provider events and identifiers never belong here.
export type CalendarEvent =
  | { kind: "timed"; start: number; end: number; title: string | null }
  | {
      kind: "all-day";
      startDate: string;
      endDate: string;
      title: string | null;
    };
export type CalendarValue = { event: CalendarEvent | null; complete: boolean };

export function calendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value
  );
}
export function isCalendarValue(value: unknown): value is CalendarValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as CalendarValue;
  if (typeof result.complete !== "boolean") return false;
  const event = result.event;
  return (
    event === null ||
    (Boolean(event) &&
      typeof event === "object" &&
      (event.title === null ||
        (typeof event.title === "string" && event.title.length <= 200)) &&
      (event.kind === "timed"
        ? Number.isSafeInteger(event.start) &&
          event.start >= 0 &&
          Number.isSafeInteger(event.end) &&
          event.end >= event.start
        : event.kind === "all-day" &&
          calendarDate(event.startDate) &&
          calendarDate(event.endDate) &&
          event.endDate > event.startDate))
  );
}
export function projectCalendar(value: CalendarValue): CalendarValue {
  const event = value.event;
  return {
    complete: value.complete,
    event: !event
      ? null
      : event.kind === "timed"
        ? {
            kind: "timed",
            start: event.start,
            end: event.end,
            title: event.title,
          }
        : {
            kind: "all-day",
            startDate: event.startDate,
            endDate: event.endDate,
            title: event.title,
          },
  };
}
