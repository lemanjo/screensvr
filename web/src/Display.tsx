import { useEffect, useState } from "react";
import type { DisplayState } from "../../src/shared/contracts.js";
import { api, ApiError } from "./api.js";
import { FaceFrame } from "./FaceFrame.js";

export function Display({ id }: { id: string }) {
  const [state, setState] = useState<DisplayState>();
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let retry: ReturnType<typeof setTimeout>;
    async function refresh() {
      const next = await api<DisplayState>(`/api/display/${id}/state`);
      if (!cancelled)
        setState((current) =>
          !current || next.revision >= current.revision ? next : current,
        );
    }
    function terminal(message: string) {
      source?.close();
      setError(message);
    }
    async function start() {
      try {
        const token = window.location.hash.slice(1);
        if (token) {
          await api(`/api/display/${id}/pair`, {
            method: "POST",
            body: JSON.stringify({ token }),
          });
          history.replaceState(null, "", window.location.pathname);
        }
        await refresh();
        if (cancelled) return;
        source = new EventSource(`/api/display/${id}/events`);
        source.addEventListener("state", (event) => {
          const next = JSON.parse((event as MessageEvent).data) as DisplayState;
          setState((current) =>
            !current || next.revision >= current.revision ? next : current,
          );
          setConnected(true);
          setError("");
        });
        source.addEventListener("revoked", () =>
          terminal(
            "This display link was revoked. Open a new link from management.",
          ),
        );
        source.onerror = () => {
          if (cancelled) return;
          setConnected(false);
          void refresh().catch((error) => {
            if (error instanceof ApiError && error.status === 401)
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
  }, [id]);

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
        <h1>Let’s reconnect this screen.</h1>
        <p role="alert">{error}</p>
        <button onClick={() => location.reload()}>Try again</button>
      </main>
    );
  if (!state)
    return (
      <main className="display-message">
        <span className="wordmark">screensvr</span>
        <p>Connecting your screen…</p>
      </main>
    );
  return (
    <main className="display-shell">
      <FaceFrame
        face={state.face}
        settings={state.settings}
        timezone={state.timezone}
        name={state.name}
      />
      {!connected && (
        <span className="reconnecting" role="status">
          Reconnecting · your face is still running
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
