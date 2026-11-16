for (let i = 0; i < 60; i++) {
  const mark = document.createElement("span");
  mark.className = `mark${i % 5 === 0 ? " major" : ""}`;
  mark.style.transform = `rotate(${i * 6}deg)`;
  document.getElementById("marks").append(mark);
}
let timezone = "UTC";
let locale = "en";
let clock;
let date;
function prepare() {
  clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  date = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}
function tick() {
  const now = new Date();
  const parts = Object.fromEntries(
    clock.formatToParts(now).map((p) => [p.type, p.value]),
  );
  const h = Number(parts.hour),
    m = Number(parts.minute),
    s = Number(parts.second);
  document.getElementById("hour").style.transform =
    `rotate(${h * 30 + m / 2}deg)`;
  document.getElementById("minute").style.transform =
    `rotate(${m * 6 + s / 10}deg)`;
  document.getElementById("second").style.transform = `rotate(${s * 6}deg)`;
  document.getElementById("date").textContent = date.format(now);
}
window.screensvr.onUpdate(({ config, context }) => {
  timezone = context.timezone;
  locale = context.locale;
  document.documentElement.style.setProperty("--accent", config.accent);
  document.documentElement.style.setProperty("--background", config.background);
  document.getElementById("caption").textContent = config.caption;
  document.getElementById("second").hidden = !config.showSeconds;
  prepare();
  tick();
});
prepare();
tick();
setInterval(tick, 1000);
