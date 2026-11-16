let config = { format: "24", showSeconds: false };
let context = { timezone: "UTC", locale: "en" };
let timeFormat;
let dateFormat;
function prepare() {
  timeFormat = new Intl.DateTimeFormat(context.locale, {
    timeZone: context.timezone,
    hour: "2-digit",
    minute: "2-digit",
    ...(config.showSeconds ? { second: "2-digit" } : {}),
    hour12: config.format === "12",
  });
  dateFormat = new Intl.DateTimeFormat(context.locale, {
    timeZone: context.timezone,
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}
function tick() {
  const now = new Date();
  const parts = timeFormat.formatToParts(now);
  document.getElementById("time").textContent = parts
    .filter((p) => p.type !== "dayPeriod")
    .map((p) => p.value)
    .join("")
    .trim();
  document.getElementById("period").textContent =
    parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  document.getElementById("date").textContent = dateFormat.format(now);
}
window.screensvr.onUpdate((update) => {
  config = update.config;
  context = update.context;
  document.documentElement.style.setProperty("--accent", config.accent);
  document.documentElement.style.setProperty("--background", config.background);
  document.getElementById("caption").textContent = config.caption;
  prepare();
  tick();
});
prepare();
tick();
setInterval(tick, 1000);
