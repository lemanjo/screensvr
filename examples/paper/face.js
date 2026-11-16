let format;
let date;
function tick() {
  if (!format) return;
  const now = new Date();
  document.getElementById("clock").textContent = format.format(now);
  document.getElementById("date").textContent = date.format(now);
}
window.screensvr.onUpdate(({ config, context }) => {
  document.getElementById("caption").textContent = config.caption;
  document.documentElement.style.setProperty("--accent", config.accent);
  document.documentElement.style.setProperty("--scale", config.scale);
  document.getElementById("date").hidden = !config.showDate;
  format = new Intl.DateTimeFormat(context.locale, {
    timeZone: context.timezone,
    hour: "2-digit",
    minute: "2-digit",
  });
  date = new Intl.DateTimeFormat(context.locale, {
    timeZone: context.timezone,
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  tick();
});
setInterval(tick, 1000);
