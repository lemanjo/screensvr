let config = {
  background: "#101615",
  clockColor: "#c9c4b8",
  accent: "#98aa9a",
  format: "24",
  showDate: true,
  roomLabel: "In this room",
  motion: true,
};
let context = { timezone: "UTC", locale: "en" };
let formatterKey;
let timeFormat;
let dateFormat;
let numberFormat;

function text(id, value) {
  const element = document.getElementById(id);
  if (element.textContent !== value) element.textContent = value;
}

function prepare() {
  const key = JSON.stringify([context.timezone, context.locale, config.format]);
  if (key === formatterKey) return;
  formatterKey = key;
  timeFormat = new Intl.DateTimeFormat(context.locale, {
    timeZone: context.timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: config.format === "12" ? "h12" : "h23",
  });
  dateFormat = new Intl.DateTimeFormat(context.locale, {
    timeZone: context.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  numberFormat = new Intl.NumberFormat(context.locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}

function tick() {
  const now = new Date();
  const parts = timeFormat.formatToParts(now);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  const period = parts.find((part) => part.type === "dayPeriod")?.value ?? "";
  text("hours", hour);
  text("minutes", minute);
  text("period", period);
  text("date", dateFormat.format(now));
  document
    .getElementById("clock")
    .setAttribute(
      "aria-label",
      `Current time: ${hour}:${minute}${period ? ` ${period}` : ""}`,
    );
}

function temperature(reading) {
  const state = reading?.status ?? "unbound";
  const hasValue =
    (state === "ready" || state === "stale") &&
    reading.type === "number" &&
    reading.quantity === "temperature" &&
    typeof reading.value === "number" &&
    Number.isFinite(reading.value) &&
    ["°C", "°F", "K"].includes(reading.unit);
  const status =
    ["unbound", "loading", "ready", "unavailable", "stale"].includes(state) &&
    ((state !== "ready" && state !== "stale") || hasValue)
      ? state
      : "unavailable";
  const value = hasValue ? numberFormat.format(reading.value) : "—";
  const unit = hasValue ? reading.unit : "";
  const note = {
    unbound: "Not connected",
    loading: "Connecting",
    ready: "",
    unavailable: "Unavailable",
    stale: "Last reading · stale",
  }[status];
  text("temperature-value", value);
  text("temperature-unit", unit);
  text("temperature-status", note);
  text("room-label", config.roomLabel);
  const room = document.getElementById("room");
  room.dataset.status = status;
  room.setAttribute(
    "aria-label",
    `${config.roomLabel || "Room temperature"}: ${hasValue ? `${value} ${unit}` : note}${status === "stale" ? ", last reading, stale" : ""}`,
  );
}

window.screensvr.onUpdate((update) => {
  config = { ...config, ...update.config };
  context = { ...context, ...update.context };
  const root = document.documentElement;
  root.style.setProperty("--background", config.background);
  root.style.setProperty("--clock", config.clockColor);
  root.style.setProperty("--accent", config.accent);
  root.dataset.motion = String(config.motion);
  document.getElementById("date").hidden = !config.showDate;
  prepare();
  tick();
  temperature(update.data?.roomTemperature);
});

prepare();
tick();
setInterval(tick, 1000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tick();
});
