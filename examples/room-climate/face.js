window.screensvr.onUpdate(({ context, data }) => {
  const format = new Intl.NumberFormat(context.locale, {
    maximumFractionDigits: 1,
  });
  const temperature = data.temperature;
  document.getElementById("name").textContent = context.name;
  const temperatureElement = document.getElementById("temperature");
  temperatureElement.textContent =
    temperature.status === "ready" || temperature.status === "stale"
      ? `${format.format(temperature.value)} ${temperature.unit}${temperature.status === "stale" ? " · stale" : ""}`
      : "—";
  document.getElementById("humidity").textContent =
    data.humidity.status === "ready"
      ? `${format.format(data.humidity.value)}% humidity`
      : "";
  document.getElementById("window").textContent =
    data.window.status === "ready"
      ? data.window.value
        ? "Window open"
        : "Window closed"
      : "";
  // Always render external text with textContent, never innerHTML.
  document.getElementById("note").textContent =
    data.note.status === "ready" ? data.note.value : "";
});
