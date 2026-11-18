/* screensvr face protocols v1/v2/v3/v4/v5. No framework or build step required. */
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
  function onUpdate(callback) {
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
  }
  function getPhoto(key, options = {}) {
    const datum = latest?.data[key];
    const value = datum?.value;
    if (
      datum?.type !== "image" ||
      !["ready", "stale"].includes(datum.status) ||
      !value?.url ||
      !/^\/api\/photos\/[A-Za-z0-9_-]{32}$/.test(value.url)
    )
      return null;
    const index = options.index ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= value.count)
      throw new RangeError("Choose an image index inside this collection.");
    const dimension = (value) => {
      if (!Number.isFinite(value) || value <= 0)
        throw new RangeError(
          "Photo dimensions must be positive finite numbers.",
        );
      return Math.min(2560, Math.ceil(value));
    };
    const width = dimension(options.width ?? (latest.context.width || 1920));
    const height = dimension(options.height ?? (latest.context.height || 1080));
    return freeze({
      url: `${value.url}?index=${index}&width=${width}&height=${height}&v=${value.revision}`,
      index,
      count: value.count,
      revision: value.revision,
      ...(value.credits ? { credit: value.credits[index] } : {}),
    });
  }
  function watchPhotos(key, callback, options = {}) {
    const interval = options.interval ?? 30000;
    if (!Number.isFinite(interval) || interval < 1000 || interval > 86400000)
      throw new RangeError(
        "Photo interval must be between 1000 and 86400000 milliseconds.",
      );
    let index = 0;
    let revision;
    let previous;
    let rotation;
    let stopped = false;
    function emit() {
      const photo = getPhoto(key, { ...options, index });
      const signature = photo?.url ?? null;
      if (signature !== previous) {
        previous = signature;
        callback(photo);
      }
    }
    function schedule() {
      const datum = latest?.data[key];
      if (
        stopped ||
        rotation ||
        datum?.type !== "image" ||
        datum.status !== "ready" ||
        !datum.value ||
        datum.value.count < 2
      )
        return;
      rotation = setTimeout(() => {
        rotation = undefined;
        expire();
        const count = latest?.data[key]?.value?.count;
        if (!stopped && count > 1 && latest.data[key].status === "ready") {
          index = options.shuffle
            ? (index + 1 + Math.floor(Math.random() * (count - 1))) % count
            : (index + 1) % count;
          try {
            emit();
          } catch {
            port?.postMessage({
              type: "error",
              message: "The face could not display its photo.",
            });
          }
        }
        schedule();
      }, interval);
    }
    const unsubscribe = onUpdate(() => {
      const datum = latest.data[key];
      const value =
        datum?.type === "image" && ["ready", "stale"].includes(datum.status)
          ? datum.value
          : null;
      if (value?.revision !== revision) {
        revision = value?.revision;
        index =
          options.shuffle && value
            ? Math.floor(Math.random() * value.count)
            : 0;
      }
      if (!value || datum.status !== "ready") {
        clearTimeout(rotation);
        rotation = undefined;
      }
      emit();
      schedule();
    });
    return () => {
      stopped = true;
      unsubscribe();
      clearTimeout(rotation);
    };
  }
  window.screensvr = Object.freeze({
    onUpdate,
    photos: Object.freeze({ get: getPhoto, watch: watchPhotos }),
  });
  window.addEventListener("message", (event) => {
    if (
      event.source !== parent ||
      event.data?.type !== "screensvr:connect" ||
      !event.ports[0]
    )
      return;
    const offered = event.data.protocols ?? [1];
    const protocolVersion = [5, 4, 3, 2, 1].find((version) =>
      offered.includes(version),
    );
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
        data: protocolVersion >= 2 ? (data.data ?? {}) : {},
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
