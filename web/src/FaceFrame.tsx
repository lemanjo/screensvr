import { useEffect, useRef, useState } from "react";
import type { FaceManifest, Settings } from "../../src/shared/contracts.js";
import type { FaceData } from "../../src/shared/face-data.js";
import { frameData } from "./face-data.js";

type Props = {
  face: FaceManifest;
  settings: Settings;
  timezone: string;
  name?: string;
  data?: FaceData;
};
export function FaceFrame(props: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const port = useRef<MessagePort | null>(null);
  const protocol = useRef(0);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(props);
  latest.current = props;
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [applied, setApplied] = useState("");
  const frameKey = `${props.face.id}/${props.face.version}/${attempt}`;
  // Hide a new document until it has applied its initial settings. In particular,
  // don't briefly show a bright face's defaults when entering a night scene.
  const connectingKey = useRef("");
  function update() {
    const { settings, timezone, name, face, data } = latest.current;
    if (!protocol.current) return;
    port.current?.postMessage({
      type: "update",
      config: settings,
      ...(protocol.current >= 2 ? { data: frameData(face, data) } : {}),
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
    connectingKey.current = frameKey;
    setApplied("");
    port.current?.close();
    protocol.current = 0;
    clearTimeout(timeout.current);
    setError("");
    const channel = new MessageChannel();
    port.current = channel.port1;
    channel.port1.onmessage = ({ data }) => {
      if (data?.type === "ready") {
        clearTimeout(timeout.current);
        const version = data.protocolVersion ?? 1;
        if (
          ![1, 2, 3].includes(version) ||
          version < latest.current.face.schemaVersion
        ) {
          setError(
            `This face requires SDK protocol v${latest.current.face.schemaVersion} or newer.`,
          );
          return;
        }
        protocol.current = version;
        update();
      }
      if (data?.type === "applied") {
        setError("");
        setApplied(connectingKey.current);
      }
      if (data?.type === "error") setError("This face encountered an error.");
    };
    frame.current?.contentWindow?.postMessage(
      { type: "screensvr:connect", protocols: [3, 2, 1] },
      "*",
      [channel.port2],
    );
    timeout.current = setTimeout(
      () => setError("This face did not start. Check its SDK compatibility."),
      6000,
    );
  }
  useEffect(update, [props.settings, props.timezone, props.name, props.data]);
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
        key={frameKey}
        style={{ visibility: applied === frameKey ? "visible" : "hidden" }}
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
