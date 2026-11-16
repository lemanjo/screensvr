/* screensvr face protocol v1. No framework or build step required. */
(() => {
  let port;
  let latest;
  const listeners = new Set();
  window.screensvr = Object.freeze({
    onUpdate(callback) {
      listeners.add(callback);
      if (latest) callback(latest);
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
    if (port) port.close();
    port = event.ports[0];
    port.onmessage = ({ data }) => {
      if (data?.type !== "update") return;
      latest = Object.freeze({ config: data.config, context: data.context });
      let failed = false;
      for (const callback of listeners) {
        try {
          callback(latest);
        } catch {
          failed = true;
          port.postMessage({
            type: "error",
            message: "The face could not apply its settings.",
          });
        }
      }
      if (!failed) port.postMessage({ type: "applied" });
    };
    port.postMessage({ type: "ready" });
  });
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
