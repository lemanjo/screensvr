import { useEffect, useState } from "react";
import type { DisplayState } from "../../src/shared/contracts.js";
import { api, ApiError } from "./api.js";
import { FaceFrame } from "./FaceFrame.js";
import { newerSnapshot } from "./snapshots.js";

export function Display({ slug }: { slug: string }) {
  const [state, setState] = useState<DisplayState>();
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let streamGeneration = 0;
    let requestGeneration = 0;
    async function refresh() {
      const stream = streamGeneration;
      const request = ++requestGeneration;
      const next = await api<DisplayState>(`/api/display/${slug}/state`);
      if (
        !cancelled &&
        stream === streamGeneration &&
        request === requestGeneration
      ) {
        history.replaceState(null, "", next.displayUrl);
        setState((current) => newerSnapshot(current, next));
      }
    }
    function terminal(message: string) {
      source?.close();
      setError(message);
    }
    async function start() {
      try {
        // Old bookmarked links may still contain a pairing fragment.
        if (window.location.hash)
          history.replaceState(null, "", window.location.pathname);
        await refresh();
        if (cancelled) return;
        source = new EventSource(`/api/display/${slug}/events`);
        source.addEventListener("state", (event) => {
          if (cancelled) return;
          streamGeneration++;
          const next = JSON.parse((event as MessageEvent).data) as DisplayState;
          setState((current) => newerSnapshot(current, next));
          setConnected(true);
          setError("");
        });
        source.addEventListener("removed", () =>
          terminal("This display has been removed from management."),
        );
        source.onerror = () => {
          if (cancelled) return;
          setConnected(false);
          void refresh().catch((error) => {
            if (error instanceof ApiError && error.status === 404)
              terminal(error.message);
          });
        };
      } catch (error) {
        if (cancelled) return;
        if (error instanceof ApiError && error.status < 500)
          terminal(error.message);
        else {
          setConnected(false);
          retry = setTimeout(() => void start(), 3000);
        }
      }
    }
    const visible = () => {
      if (document.visibilityState === "visible")
        void refresh().catch(() => {});
    };
    document.addEventListener("visibilitychange", visible);
    void start();
    return () => {
      cancelled = true;
      source?.close();
      clearTimeout(retry);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [slug]);

  useEffect(() => {
    let lock: WakeLockSentinel | undefined;
    let disposed = false;
    const acquire = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        const next = await navigator.wakeLock?.request("screen");
        if (disposed) await next?.release();
        else lock = next;
      } catch {
        /* Kiosk browsers or insecure LAN origins may not support wake locks. */
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      disposed = true;
      void lock?.release();
      document.removeEventListener("visibilitychange", acquire);
    };
  }, []);

  if (error)
    return (
      <main className="display-message">
        <span className="wordmark">screensvr</span>
        <h1>This display is unavailable.</h1>
        <p role="alert">{error}</p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>
    );
  if (!state)
    return (
      <main className="display-message">
        <span className="wordmark">screensvr</span>
        <p>Connecting…</p>
      </main>
    );
  return (
    <main className="display-shell">
      <FaceFrame
        face={state.face}
        settings={state.settings}
        timezone={state.timezone}
        name={state.name}
        data={state.data}
      />
      {!connected && (
        <span className="reconnecting" role="status">
          Reconnecting…
        </span>
      )}
      {document.fullscreenEnabled && (
        <button
          className="fullscreen"
          aria-label="Enter fullscreen"
          title="Enter fullscreen"
          onClick={() =>
            void document.documentElement.requestFullscreen().catch(() => {})
          }
        >
          ⛶
        </button>
      )}
    </main>
  );
}
