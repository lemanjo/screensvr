import { useEffect, useRef, useState } from "react";
import type { FaceManifest, Settings } from "../../src/shared/contracts.js";

type Props = {
  face: FaceManifest;
  settings: Settings;
  timezone: string;
  name?: string;
};
export function FaceFrame(props: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  function update() {
    const { settings, timezone, name } = latest.current;
    port.current?.postMessage({
      type: "update",
      config: settings,
      context: {
        timezone,
        name: name ?? "Preview",
        locale: navigator.language,
        width: frame.current?.clientWidth ?? 0,
        height: frame.current?.clientHeight ?? 0,
      },
    });
  }
  function connect() {
    port.current?.close();
    clearTimeout(timeout.current);
    setError("");
    const channel = new MessageChannel();
    port.current = channel.port1;
    channel.port1.onmessage = ({ data }) => {
      if (data?.type === "ready") {
        clearTimeout(timeout.current);
        update();
      }
      if (data?.type === "applied") setError("");
      if (data?.type === "error") setError("This face encountered an error.");
    };
    frame.current?.contentWindow?.postMessage(
      { type: "screensvr:connect" },
      "*",
      [channel.port2],
    );
    timeout.current = setTimeout(
      () => setError("This face did not start. Check its SDK compatibility."),
      6000,
    );
  }
  useEffect(update, [props.settings, props.timezone, props.name]);
  useEffect(() => {
    const observer = new ResizeObserver(update);
    if (frame.current) observer.observe(frame.current);
    return () => {
      observer.disconnect();
      port.current?.close();
      clearTimeout(timeout.current);
    };
  }, []);
  return (
    <div className="face-frame">
      <iframe
        key={`${props.face.id}/${props.face.version}/${attempt}`}
        ref={frame}
        title={`${props.face.name} face`}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={`/faces/${props.face.id}/${props.face.version}/${props.face.entry}`}
        onLoad={connect}
      />
      {error && (
        <div className="face-error" role="alert">
          <span>{error}</span>
          <button onClick={() => setAttempt((value) => value + 1)}>
            Retry face
          </button>
        </div>
      )}
    </div>
  );
}
