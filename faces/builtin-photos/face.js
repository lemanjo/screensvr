let context = { timezone: "UTC", locale: "en" };
let config = { format: "24", showClock: true };
let stop;
let playback;
let requested = null;
let generation = 0;
let retry;
const photo = document.getElementById("photo");
const placeholder = document.getElementById("placeholder");

function showPhoto(image) {
  clearTimeout(retry);
  requested = image;
  const current = ++generation;
  if (!image) {
    photo.hidden = true;
    photo.removeAttribute("src");
    placeholder.hidden = false;
    return;
  }
  // Keep the previous image visible until its replacement has fully loaded.
  const next = new Image();
  next.onload = () => {
    if (current !== generation) return;
    photo.src = image.url;
    photo.hidden = false;
    placeholder.hidden = true;
  };
  next.onerror = () => {
    if (current !== generation) return;
    if (photo.hidden) {
      placeholder.textContent = "Photos are temporarily unavailable.";
      placeholder.hidden = false;
    }
    retry = setTimeout(() => showPhoto(requested), 15000);
  };
  next.src = image.url;
}
function tick() {
  const now = new Date();
  document.getElementById("time").textContent = new Intl.DateTimeFormat(
    context.locale,
    {
      timeZone: context.timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: config.format === "12",
    },
  ).format(now);
  document.getElementById("date").textContent = new Intl.DateTimeFormat(
    context.locale,
    {
      timeZone: context.timezone,
      weekday: "long",
      month: "long",
      day: "numeric",
    },
  ).format(now);
}
window.screensvr.onUpdate((update) => {
  config = update.config;
  context = update.context;
  document.documentElement.style.setProperty("--fit", config.fit);
  document.getElementById("clock").hidden = !config.showClock;
  document.getElementById("shade").hidden = !config.showClock;
  const status = update.data.photos?.status;
  placeholder.textContent =
    status === "unbound"
      ? "Choose a photo source in display settings."
      : status === "loading"
        ? "Loading photos…"
        : "Photos are temporarily unavailable.";
  const nextPlayback = JSON.stringify([config.interval, config.shuffle]);
  if (nextPlayback !== playback) {
    playback = nextPlayback;
    stop?.();
    stop = window.screensvr.photos.watch("photos", showPhoto, {
      interval: config.interval * 1000,
      shuffle: config.shuffle,
    });
  }
  tick();
});
tick();
setInterval(tick, 1000);
