const root = document.documentElement;
const labels = {
  "clear-day": "Clear skies",
  "clear-night": "Clear night",
  "partly-cloudy": "Partly cloudy",
  cloudy: "Cloudy",
  rain: "Rain",
  "heavy-rain": "Heavy rain",
  snow: "Snow",
  sleet: "Rain and snow",
  hail: "Hail",
  fog: "Fog",
  wind: "Windy",
  "windy-cloudy": "Wind and clouds",
  thunderstorm: "Thunderstorms",
  "thunderstorm-rain": "Thunderstorms and rain",
};
const skies = {
  "clear-day": "clear-day",
  "clear-night": "clear-night",
  "partly-cloudy": "cloud",
  cloudy: "cloud",
  rain: "rain",
  "heavy-rain": "rain",
  snow: "snow",
  sleet: "sleet",
  hail: "snow",
  fog: "fog",
  wind: "wind",
  "windy-cloudy": "wind",
  thunderstorm: "cloud",
  "thunderstorm-rain": "rain",
};
let config = {
  background: "#10191e",
  text: "#e1e5df",
  accent: "#a3b9b5",
  location: "Outside",
  format: "24",
  showDate: true,
  forecast: "daily",
  motion: true,
};
let context = { timezone: "UTC", locale: "en" };
let data = {};
let formatKey;
let timeFormat;
let dateFormat;
let dayFormat;
let hourFormat;
let calendarFormat;
let numberFormat;
let renderedMinute;

function text(id, value) {
  const element = document.getElementById(id);
  if (element.textContent !== value) element.textContent = value;
}
function prepare() {
  const key = JSON.stringify([context.timezone, context.locale, config.format]);
  if (key === formatKey) return;
  formatKey = key;
  const zone = { timeZone: context.timezone };
  timeFormat = new Intl.DateTimeFormat(context.locale, {
    ...zone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: config.format === "12" ? "h12" : "h23",
  });
  dateFormat = new Intl.DateTimeFormat(context.locale, {
    ...zone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  dayFormat = new Intl.DateTimeFormat(context.locale, {
    ...zone,
    weekday: "short",
  });
  hourFormat = new Intl.DateTimeFormat(context.locale, {
    ...zone,
    hour: "numeric",
    hourCycle: config.format === "12" ? "h12" : "h23",
    // Distinguish repeated local hours when daylight saving time ends.
    timeZoneName: "short",
  });
  calendarFormat = new Intl.DateTimeFormat("en", {
    ...zone,
    calendar: "iso8601",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  numberFormat = new Intl.NumberFormat(context.locale, {
    maximumFractionDigits: 1,
  });
}
function dayKey(at) {
  const parts = calendarFormat.formatToParts(at);
  return ["year", "month", "day"]
    .map((part) => parts.find((item) => item.type === part).value)
    .join("-");
}
function usable(datum) {
  return datum && ["ready", "stale"].includes(datum.status) && datum.value;
}
function state(datum) {
  if (datum?.status === "ready" && datum.expiresAt <= Date.now())
    return "stale";
  return datum?.status ?? "unbound";
}
function degrees(value, unit) {
  return typeof value === "number" && Number.isFinite(value) && unit
    ? `${numberFormat.format(value)}${unit}`
    : "—";
}
function renderCurrent() {
  const datum = data.weather;
  const status = state(datum);
  const value = usable(datum);
  text("location", config.location);
  text(
    "temperature",
    value?.temperature === null || !value
      ? "—"
      : numberFormat.format(value.temperature),
  );
  text("unit", value?.temperature === null || !value ? "" : (datum.unit ?? ""));
  text(
    "condition",
    value
      ? (labels[value.condition] ?? "Condition unavailable")
      : ({
          unbound: "Weather not connected",
          loading: "Connecting to the weather",
          unavailable: "Weather unavailable",
        }[status] ?? "Weather unavailable"),
  );
  text("weather-status", status === "stale" ? "Last reading · stale" : "");
  document.getElementById("current").dataset.status = status;
  // Never imply that a forecast or an old reading describes the sky right now.
  root.dataset.sky =
    status === "ready" && value
      ? (skies[value.condition] ?? "neutral")
      : "neutral";
}
function renderForecast(now) {
  const section = document.getElementById("forecast");
  section.hidden = config.forecast === "off";
  if (section.hidden) return;
  const daily = config.forecast === "daily";
  const datum = data[daily ? "daily" : "hourly"];
  const status = state(datum);
  const value = usable(datum);
  const today = dayKey(now);
  const entries = (value?.entries ?? [])
    .filter((entry) =>
      daily
        ? dayKey(entry.at) >= today
        : entry.at >= Math.floor(now / 3600000) * 3600000,
    )
    .slice(0, daily ? 3 : 6);
  text("forecast-label", daily ? "THE DAYS AHEAD" : "THE HOURS AHEAD");
  text(
    "forecast-status",
    entries.length
      ? status === "stale"
        ? "Last forecast · stale"
        : ""
      : ({
          unbound: "Forecast not connected",
          loading: "Loading forecast",
        }[status] ?? "Forecast unavailable"),
  );
  section.dataset.status = status;
  const container = document.getElementById("forecast-entries");
  container.replaceChildren();
  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "forecast-entry";
    const when = document.createElement("p");
    when.className = "forecast-time";
    when.textContent = daily
      ? dayKey(entry.at) === today
        ? "Today"
        : dayFormat.format(entry.at)
      : hourFormat.format(entry.at);
    const condition = document.createElement("p");
    condition.className = "forecast-condition";
    condition.textContent = labels[entry.condition] ?? "—";
    const temperature = document.createElement("p");
    temperature.className = "forecast-temperature";
    temperature.textContent = daily
      ? `${degrees(entry.temperature, datum.unit)} / ${degrees(entry.low, datum.unit)}`
      : degrees(entry.temperature, datum.unit);
    item.append(when, condition, temperature);
    container.append(item);
  }
}
function tick(force = false) {
  const now = Date.now();
  const parts = timeFormat.formatToParts(now);
  text(
    "clock",
    parts
      .filter((part) => part.type !== "dayPeriod")
      .map((part) => part.value)
      .join("")
      .trim(),
  );
  text("period", parts.find((part) => part.type === "dayPeriod")?.value ?? "");
  text("date", dateFormat.format(now));
  if (force || renderedMinute !== Math.floor(now / 60000)) {
    renderedMinute = Math.floor(now / 60000);
    renderCurrent();
    renderForecast(now);
  }
}
// Fixed, deterministic particle count: no animation loop or per-frame JS.
const precipitation = document.getElementById("precipitation");
for (let index = 0; index < 28; index++) {
  const particle = document.createElement("i");
  particle.style.setProperty("--x", `${(index * 37 + 11) % 100}%`);
  particle.style.setProperty("--delay", `${-(index * 1.73)}s`);
  particle.style.setProperty("--speed", `${1 + (index % 5) / 5}`);
  precipitation.append(particle);
}
function visibility() {
  root.dataset.hidden = String(document.visibilityState === "hidden");
  if (document.visibilityState !== "hidden") tick(true);
}
window.screensvr.onUpdate((update) => {
  config = { ...config, ...update.config };
  context = { ...context, ...update.context };
  data = update.data ?? {};
  root.style.setProperty("--background", config.background);
  root.style.setProperty("--text", config.text);
  root.style.setProperty("--accent", config.accent);
  root.dataset.motion = String(config.motion);
  document.getElementById("date").hidden = !config.showDate;
  prepare();
  tick(true);
});
prepare();
tick(true);
visibility();
setInterval(() => {
  if (document.visibilityState !== "hidden") tick();
}, 1000);
document.addEventListener("visibilitychange", visibility);
window.addEventListener("pageshow", () => tick(true));
