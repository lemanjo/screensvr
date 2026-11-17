(() => {
  const elements = Object.fromEntries(
    ["time", "date", "label", "title", "when", "status"].map((id) => [
      id,
      document.getElementById(id),
    ]),
  );
  let state;
  const localDate = (time, timezone) => {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(time);
    const get = (name) => parts.find((part) => part.type === name).value;
    return `${get("year")}-${get("month")}-${get("day")}`;
  };
  function render() {
    if (!state) return;
    const { config, context, data } = state;
    const now = Date.now();
    const zone = context.timezone;
    const locale = context.locale;
    const today = localDate(now, zone);
    const format = (time, options) =>
      new Intl.DateTimeFormat(locale, { timeZone: zone, ...options }).format(
        time,
      );
    const clockOptions = {
      hour: "numeric",
      minute: "2-digit",
      ...(config.format === "12" ? { hour12: true } : { hourCycle: "h23" }),
    };
    elements.time.textContent = format(now, clockOptions);
    elements.date.hidden = !config.showDate;
    elements.date.textContent = format(now, {
      weekday: "long",
      month: "long",
      day: "numeric",
    });
    const datum = data.calendar;
    const usable = datum && ["ready", "stale"].includes(datum.status);
    const event = usable ? datum.value?.event : null;
    const stale =
      datum?.status === "stale" ||
      (datum?.expiresAt !== null && datum?.expiresAt <= now) ||
      datum?.value?.complete === false;
    const ended =
      event &&
      (event.kind === "timed" ? event.end <= now : event.endDate <= today);
    elements.status.textContent = stale ? "Calendar may be out of date" : "";
    if (!event || ended) {
      elements.label.textContent = "A LITTLE ROOM IN THE DAY";
      elements.when.textContent = "";
      elements.title.textContent = ended
        ? "Updating your next appointment…"
        : !datum || datum.status === "unbound"
          ? "Your time, quietly."
          : datum.status === "loading"
            ? "Finding your next appointment…"
            : datum.status === "unavailable"
              ? "Calendar unavailable"
              : stale
                ? "Calendar unavailable"
                : "No appointments in the next 30 days";
      return;
    }
    const ongoing = event.kind === "timed" && event.start <= now;
    elements.label.textContent = ongoing ? "NOW" : "UP NEXT";
    elements.title.textContent = event.title || "Busy";
    if (event.kind === "all-day") {
      // Date-only values never pass through the display timezone as UTC instants.
      const date =
        event.startDate <= today
          ? "Today"
          : new Intl.DateTimeFormat(locale, {
              timeZone: "UTC",
              month: "short",
              day: "numeric",
            }).format(new Date(`${event.startDate}T12:00:00Z`));
      elements.when.textContent = `${date} · All day`;
    } else {
      const date =
        localDate(event.start, zone) === today
          ? "Today"
          : format(event.start, {
              weekday: "short",
              month: "short",
              day: "numeric",
            });
      const endDate =
        localDate(event.end, zone) === localDate(event.start, zone)
          ? ""
          : `${format(event.end, { weekday: "short", month: "short", day: "numeric" })} `;
      elements.when.textContent = `${date} · ${format(event.start, clockOptions)} – ${endDate}${format(event.end, clockOptions)}`;
    }
  }
  window.screensvr.onUpdate((update) => {
    state = update;
    for (const key of ["background", "text", "accent"])
      document.documentElement.style.setProperty(
        `--${key}`,
        update.config[key],
      );
    render();
  });
  setInterval(render, 1000);
  document.addEventListener("visibilitychange", render);
  window.addEventListener("pageshow", render);
})();
