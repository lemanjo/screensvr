const dial = document.getElementById("clock");
const hour = document.getElementById("hour");
const minute = document.getElementById("minute");
let clock;
let label;

function prepare(timezone = "UTC", locale = "en") {
  clock = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  label = new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  });
}

function tick() {
  const now = new Date();
  const parts = Object.fromEntries(
    clock.formatToParts(now).map((part) => [part.type, part.value]),
  );
  const minutes = Number(parts.minute) + Number(parts.second) / 60;
  const hours = (Number(parts.hour) % 12) + minutes / 60;
  hour.setAttribute("transform", `rotate(${hours * 30} 200 200)`);
  minute.setAttribute("transform", `rotate(${minutes * 6} 200 200)`);
  dial.setAttribute("aria-label", `Current time: ${label.format(now)}`);
}

window.screensvr.onUpdate(({ config, context }) => {
  const root = document.documentElement;
  root.style.setProperty("--color-one", config.colorOne);
  root.style.setProperty("--color-two", config.colorTwo);
  root.style.setProperty("--color-three", config.colorThree);
  root.style.setProperty("--clock-color", config.clockColor);
  root.dataset.animate = String(config.animate);
  prepare(context.timezone, context.locale);
  tick();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") tick();
});

prepare();
tick();
setInterval(tick, 1000);
