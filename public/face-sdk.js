/* screensvr face protocols v1/v2. No framework or build step required. */
(() => {
  let port;
  let latest;
  let timer;
  const listeners = new Set();
  function freeze(value) {
    if (value && typeof value === "object") {
      for (const child of Object.values(value)) freeze(child);
      Object.freeze(value);
    }
    return value;
  }
  function notify() {
    let failed = false;
    for (const callback of listeners) {
      try {
        callback(latest);
      } catch {
        failed = true;
        port?.postMessage({
          type: "error",
          message: "The face could not apply its update.",
        });
      }
    }
    if (!failed) port?.postMessage({ type: "applied" });
  }
  function expire() {
    clearTimeout(timer);
    if (!latest) return;
    const now = Date.now();
    let next = Infinity;
    let changed = false;
    const data = Object.fromEntries(
      Object.entries(latest.data).map(([key, value]) => {
        if (value.status === "ready" && value.expiresAt !== null) {
          if (value.expiresAt <= now) {
            changed = true;
            return [key, { ...value, status: "stale" }];
          }
          next = Math.min(next, value.expiresAt);
        }
        return [key, value];
      }),
    );
    if (changed) {
      latest = freeze({ ...latest, data });
      notify();
    }
    if (next !== Infinity)
      timer = setTimeout(expire, Math.max(1, Math.min(2147483647, next - now)));
  }
  window.screensvr = Object.freeze({
    onUpdate(callback) {
      expire();
      listeners.add(callback);
      if (latest) {
        try {
          callback(latest);
        } catch {
          port?.postMessage({
            type: "error",
            message: "The face could not apply its update.",
          });
        }
      }
      return () => listeners.delete(callback);
    },
  });
  window.addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== "screensvr:connect" ||
      !event.ports[0]
    )
      return;
    const offered = event.data.protocols ?? [1];
    const protocolVersion = offered.includes(2)
      ? 2
      : offered.includes(1)
        ? 1
        : 0;
    if (!protocolVersion) return;
    port?.close();
    clearTimeout(timer);
    latest = undefined;
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type !== "update") return;
      latest = freeze({
        config: data.config,
        context: data.context,
        data: protocolVersion === 2 ? (data.data ?? {}) : {},
      });
      // Expire before notifying so an already-expired snapshot is never fresh.
      const now = Date.now();
      latest = freeze({
        ...latest,
        data: Object.fromEntries(
          Object.entries(latest.data).map(([key, value]) => [
            key,
            value.status === "ready" &&
            value.expiresAt !== null &&
            value.expiresAt <= now
              ? { ...value, status: "stale" }
              : value,
          ]),
        ),
      });
      notify();
      expire();
    };
    port.postMessage({ type: "ready", protocolVersion });
  });
  document.addEventListener("visibilitychange", expire);
  window.addEventListener("pageshow", expire);
  window.addEventListener("error", () =>
    port?.postMessage({
      type: "error",
      message: "The face encountered an error.",
    }),
  );
  window.addEventListener("unhandledrejection", () =>
    port?.postMessage({
      type: "error",
      message: "The face encountered an error.",
    }),
  );
})();
