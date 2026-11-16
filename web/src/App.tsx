import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  validateSettings,
  type Device,
  type Face,
  type Settings,
  type Setting,
} from "../../src/shared/contracts.js";
import { api, ApiError, errorMessage, setCSRF } from "./api.js";
import { FaceFrame } from "./FaceFrame.js";
import { Select } from "./Select.js";

const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = ["UTC", localTimezone, ...Intl.supportedValuesOf("timeZone")];
type Auth = { configured: boolean; authenticated: boolean; csrf?: string };
type IconName =
  | "display"
  | "grid"
  | "plus"
  | "arrow"
  | "upload"
  | "close"
  | "settings"
  | "leaf"
  | "link";
function Icon({ name }: { name: IconName }) {
  const paths: Record<IconName, ReactNode> = {
    display: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M5 12h14m-6-6 6 6-6 6" />,
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    leaf: (
      <>
        <path d="M20 4C7 2 1 11 7 17c6 6 15 0 13-13Z" />
        <path d="m5 20 10-10" />
      </>
    ),
    link: (
      <>
        <path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0" />
      </>
    ),
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onClose);
  dismiss.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    ref.current?.querySelector<HTMLElement>("button, input, select")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismiss.current();
      if (event.key !== "Tab") return;
      const elements = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], textarea:not(:disabled)",
        ) ?? []),
      ];
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener("keydown", key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${wide ? "dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Login({
  auth,
  onLogin,
}: {
  auth: Auth;
  onLogin: (csrf: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ csrf: string }>(
        `/api/auth/${auth.configured ? "login" : "setup"}`,
        { method: "POST", body: JSON.stringify({ password }) },
      );
      onLogin(result.csrf);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-layout">
      <div className="login-art">
        <span className="eyebrow">LESS NOISE. MORE ATMOSPHERE.</span>
        <h1>
          A beautiful place
          <br />
          to do nothing.
        </h1>
        <div className="art-orbit">
          <span />
          <span />
          <span />
        </div>
        <p>Your screens. Your space. Your little moment of calm.</p>
      </div>
      <section className="login-panel">
        <div className="brand">
          <span className="brand-symbol" />
          screensvr<span className="version">v0.1</span>
        </div>
        <h2>{auth.configured ? "Welcome back." : "Make yourself at home."}</h2>
        <p>
          {auth.configured
            ? "Sign in to give your screens a little atmosphere."
            : "Set an administrator password to get your first screen glowing."}
        </p>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            Administrator password
            <input
              type="password"
              minLength={12}
              maxLength={128}
              required
              autoComplete={
                auth.configured ? "current-password" : "new-password"
              }
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <small>
            At least 12 characters. Keep this password somewhere safe.
          </small>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full-width" disabled={busy}>
            {busy
              ? "One moment…"
              : auth.configured
                ? "Sign in"
                : "Create your space"}
            <Icon name="arrow" />
          </button>
        </form>
        {!auth.configured && (
          <p className="fine-print">
            First-run setup claims this server. Complete setup on a trusted
            network before exposing it to other users.
          </p>
        )}
        <span className="local-note">
          <Icon name="leaf" /> Self-hosted. Local-first. Entirely yours.
        </span>
      </section>
    </main>
  );
}

function SettingField({
  setting,
  value,
  onChange,
}: {
  setting: Setting;
  value: string | number | boolean;
  onChange: (value: string | number | boolean) => void;
}) {
  if (setting.type === "boolean")
    return (
      <label className="toggle-field">
        <span>{setting.label}</span>
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    );
  if (setting.type === "select")
    return (
      <Select
        label={setting.label}
        value={String(value)}
        onChange={onChange}
        options={setting.options}
      />
    );
  if (setting.type === "color")
    return (
      <label>
        {setting.label}
        <div className="color-field">
          <input
            type="color"
            value={String(value)}
            onChange={(event) => onChange(event.target.value)}
          />
          <span>{String(value).toUpperCase()}</span>
        </div>
      </label>
    );
  return (
    <label>
      {setting.label}
      <input
        type={setting.type === "number" ? "number" : "text"}
        value={String(value)}
        min={setting.type === "number" ? setting.min : undefined}
        max={setting.type === "number" ? setting.max : undefined}
        step={setting.type === "number" ? (setting.step ?? "any") : undefined}
        maxLength={setting.type === "text" ? 200 : undefined}
        required={setting.type === "number"}
        onChange={(event) =>
          onChange(
            setting.type === "number"
              ? Number(event.target.value)
              : event.target.value,
          )
        }
      />
    </label>
  );
}

function DeviceEditor({
  device,
  faces,
  onClose,
  onSave,
}: {
  device: Device;
  faces: Face[];
  onClose: () => void;
  onSave: (body: object) => Promise<void>;
}) {
  const [name, setName] = useState(device.name);
  const [timezone, setTimezone] = useState(device.timezone);
  const [faceId, setFaceId] = useState(device.faceId);
  const [settings, setSettings] = useState<Settings>(device.settings);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const face = faces.find((face) => face.manifest.id === faceId);
  if (!face)
    return (
      <Dialog title="This face is no longer installed" onClose={onClose}>
        <div className="dialog-body">
          <p>Close settings and choose another installed face.</p>
          <button className="primary" onClick={onClose}>
            Close settings
          </button>
        </div>
      </Dialog>
    );
  let previewTimezone = timezone;
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
  } catch {
    previewTimezone = device.timezone;
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await onSave({
        name,
        timezone,
        faceId,
        settings,
        revision: device.revision,
      });
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Set the mood" onClose={onClose} wide>
      <div className="editor-layout">
        <section className="editor-preview">
          <div className="preview-screen">
            <FaceFrame
              face={face.manifest}
              settings={settings}
              timezone={previewTimezone}
              name={name}
            />
          </div>
          <span className="preview-label">
            <span className="status-dot" />
            LIVE PREVIEW
          </span>
          <p>Try something new. Changes go live when you save.</p>
        </section>
        <form className="editor-form" onSubmit={(event) => void submit(event)}>
          <span className="eyebrow">YOUR DISPLAY</span>
          <label>
            Display name
            <input
              required
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <Select
            label="Timezone"
            value={timezone}
            searchable
            onChange={setTimezone}
            options={[...new Set([device.timezone, ...zones])]
              .sort()
              .map((zone) => ({
                value: zone,
                label: zone.replaceAll("_", " "),
              }))}
          />
          <Select
            label="Screen face"
            value={faceId}
            onChange={(value) => {
              setFaceId(value);
              setSettings(
                validateSettings(
                  faces.find((face) => face.manifest.id === value)!.manifest,
                  {},
                ),
              );
            }}
            options={faces.map((face) => ({
              value: face.manifest.id,
              label: face.manifest.name,
            }))}
          />
          <div className="form-divider" />
          <span className="eyebrow">MAKE IT YOURS</span>
          {face.manifest.settings.length === 0 && (
            <p>This face has no settings.</p>
          )}
          {face.manifest.settings.map((setting) => (
            <SettingField
              key={setting.key}
              setting={setting}
              value={settings[setting.key] ?? setting.default}
              onChange={(value) =>
                setSettings((current) => ({ ...current, [setting.key]: value }))
              }
            />
          ))}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="secondary" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save changes"}
              <Icon name="arrow" />
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}

function AddDevice({
  faces,
  onClose,
  onCreate,
}: {
  faces: Face[];
  onClose: () => void;
  onCreate: (body: object) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [faceId, setFaceId] = useState(faces[0]?.manifest.id ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await onCreate({ name, faceId, timezone: localTimezone });
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="A new place to unwind" onClose={onClose}>
      <form className="dialog-body" onSubmit={(event) => void submit(event)}>
        <p>
          Give your display a name. Then open its permanent link on your tablet,
          monitor, or kiosk.
        </p>
        <label>
          Display name
          <input
            placeholder="e.g. Hallway tablet"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <Select
          label="Start with a face"
          value={faceId}
          onChange={setFaceId}
          options={faces.map((face) => ({
            value: face.manifest.id,
            label: face.manifest.name,
          }))}
        />
        <small>
          Timezone: {localTimezone}. You can change this in display settings.
        </small>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary full-width" disabled={busy}>
          {busy ? "Creating…" : "Create display"}
          <Icon name="arrow" />
        </button>
      </form>
    </Dialog>
  );
}

function DisplayLink({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title="Your screen is ready" onClose={onClose}>
      <div className="dialog-body">
        <div className="display-link-symbol">
          <Icon name="display" />
        </div>
        <p>
          Open this permanent address in your display’s browser. You can always
          find the same link here.
        </p>
        <label>
          Display URL
          <input
            className="link-input"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <div className="form-actions">
          <button
            className="secondary"
            onClick={() =>
              void navigator.clipboard
                ?.writeText(url)
                .then(() => setCopied(true))
                .catch(() => setCopied(false))
            }
          >
            {copied ? "Copied!" : "Copy link"}
          </button>
          <a className="primary" href={url} target="_blank" rel="noreferrer">
            Open display
            <Icon name="arrow" />
          </a>
        </div>
        <small>
          This address stays the same, even if you rename the display. Anyone
          who can reach this server can view it.
        </small>
      </div>
    </Dialog>
  );
}

function Install({
  file,
  onClose,
  onInstall,
}: {
  file: File;
  onClose: () => void;
  onInstall: () => Promise<void>;
}) {
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog title="A new face for your space" onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          void onInstall().catch((error) => {
            setError(errorMessage(error));
            setBusy(false);
          });
        }}
      >
        <div className="package-info">
          <Icon name="upload" />
          <div>
            <strong>{file.name}</strong>
            <small>{(file.size / 1024).toFixed(0)} KiB · Face package</small>
          </div>
        </div>
        <p>
          Face packages contain executable JavaScript. We sandbox faces and
          block their network access, but v0.1 is for{" "}
          <strong>trusted packages only</strong>.
        </p>
        <label className="trust-check">
          <input
            type="checkbox"
            required
            checked={trusted}
            onChange={(event) => setTrusted(event.target.checked)}
          />
          <span>I trust the source of this package.</span>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary full-width" disabled={!trusted || busy}>
          {busy ? "Installing…" : "Install face"}
          <Icon name="arrow" />
        </button>
      </form>
    </Dialog>
  );
}

export function App() {
  const [auth, setAuth] = useState<Auth>();
  const [faces, setFaces] = useState<Face[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [page, setPage] = useState<"displays" | "faces">("displays");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Device>();
  const [displayLink, setDisplayLink] = useState("");
  const [installing, setInstalling] = useState<File>();
  const [removing, setRemoving] = useState<{
    id: string;
    name: string;
    type: "devices" | "faces";
  }>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  async function load() {
    try {
      const [nextFaces, nextDevices] = await Promise.all([
        api<Face[]>("/api/faces"),
        api<Device[]>("/api/devices"),
      ]);
      setFaces(nextFaces);
      setDevices(nextDevices);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401)
        setAuth({ configured: true, authenticated: false });
      else throw error;
    }
  }
  useEffect(() => {
    void api<Auth>("/api/auth/status")
      .then((status) => {
        setCSRF(status.csrf ?? "");
        setAuth(status);
      })
      .catch((error) => setError(errorMessage(error)));
  }, []);
  useEffect(() => {
    if (!auth?.authenticated) return;
    void load().catch((error) => setError(errorMessage(error)));
    const interval = setInterval(() => void load().catch(() => {}), 15000);
    return () => clearInterval(interval);
  }, [auth?.authenticated]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timeout);
  }, [notice]);

  if (!auth)
    return (
      <main className="display-message">
        <span className="wordmark">screensvr</span>
        <p>{error || "Finding your space…"}</p>
        {error && <button onClick={() => location.reload()}>Try again</button>}
      </main>
    );
  if (!auth.authenticated)
    return (
      <Login
        auth={auth}
        onLogin={(csrf) => {
          setCSRF(csrf);
          setAuth({ configured: true, authenticated: true });
          setError("");
        }}
      />
    );
  const online = devices.filter((device) => device.online).length;
  return (
    <div className="app-layout">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="screensvr home">
          <span className="brand-symbol" />
          screensvr
        </a>
        <span className="workspace-label">YOUR LITTLE CORNER</span>
        <nav aria-label="Main navigation">
          <button
            className={page === "displays" ? "active" : ""}
            onClick={() => setPage("displays")}
          >
            <Icon name="display" />
            Displays<span className="nav-count">{devices.length}</span>
          </button>
          <button
            className={page === "faces" ? "active" : ""}
            onClick={() => setPage("faces")}
          >
            <Icon name="grid" />
            Face library<span className="nav-count">{faces.length}</span>
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <Icon name="leaf" />
            <strong>A little less connected.</strong>
            <span>
              <span className="status-dot" /> LOCAL & LOVELY
            </span>
          </div>
          <div className="sidebar-footer">
            <span>
              screensvr <span className="version">v0.1</span>
            </span>
            <button
              className="text-button"
              onClick={() =>
                void api("/api/auth/logout", { method: "POST" })
                  .then(() => {
                    setCSRF("");
                    setAuth({ configured: true, authenticated: false });
                  })
                  .catch((error) => setError(errorMessage(error)))
              }
            >
              Sign out
            </button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar">
          <span>
            <span className="breadcrumb">Your space</span>
            <span className="crumb-separator">/</span>
            {page === "displays" ? "Displays" : "Face library"}
          </span>
          <span className="server-status">
            <span className="status-dot" /> YOUR SELF-HOSTED SPACE
          </span>
        </header>
        <div className="page-content">
          {error && (
            <div className="error banner" role="alert">
              {error}
              <button className="text-button" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
          <section className="page-heading">
            <div>
              <span className="eyebrow">
                {page === "displays"
                  ? "GOOD THINGS HAPPEN IN THE QUIET."
                  : "A DIFFERENT KIND OF SCREEN TIME."}
              </span>
              <h1>
                {page === "displays"
                  ? "Make room for a little calm."
                  : "Find your screen’s personality."}
              </h1>
              <p>
                {page === "displays"
                  ? "Beautiful, unhurried moments. On every screen you call yours."
                  : "A collection of little worlds. Pick a face, make it your own."}
              </p>
            </div>
            <button
              className="primary"
              onClick={() =>
                page === "displays" ? setAdding(true) : input.current?.click()
              }
            >
              <Icon name={page === "displays" ? "plus" : "upload"} />
              {page === "displays" ? "Add display" : "Install a face"}
            </button>
          </section>
          {page === "displays" ? (
            <>
              <div className="section-title">
                <h2>
                  Your displays <span>{devices.length}</span>
                </h2>
                <span className="muted">
                  {online} online <span className="text-dot">·</span>{" "}
                  {devices.length - online} offline
                </span>
              </div>
              {devices.length === 0 ? (
                <section className="empty-state">
                  <div className="empty-preview">
                    {faces[0] && (
                      <FaceFrame
                        face={faces[0].manifest}
                        settings={validateSettings(faces[0].manifest, {})}
                        timezone={localTimezone}
                      />
                    )}
                  </div>
                  <div>
                    <span className="eyebrow">ONE SCREEN. A FRESH START.</span>
                    <h2>
                      Every idle screen
                      <br />
                      has a softer side.
                    </h2>
                    <p>
                      A hallway tablet. A spare monitor. A quiet corner.
                      <br />
                      Let’s give yours something beautiful to do.
                    </p>
                    <button className="primary" onClick={() => setAdding(true)}>
                      Connect your first display
                      <Icon name="arrow" />
                    </button>
                  </div>
                </section>
              ) : (
                <div className="device-grid">
                  {devices.map((device) => {
                    const face = faces.find(
                      (face) => face.manifest.id === device.faceId,
                    );
                    return (
                      <article className="device-card" key={device.id}>
                        <div className="device-preview">
                          {face && (
                            <FaceFrame
                              face={face.manifest}
                              settings={device.settings}
                              timezone={device.timezone}
                              name={device.name}
                            />
                          )}
                          <span
                            className={`connection-badge ${device.online ? "is-online" : ""}`}
                          >
                            <span className="status-dot" />
                            {device.online ? "Online" : "Offline"}
                          </span>
                        </div>
                        <div className="device-info">
                          <div>
                            <h3>{device.name}</h3>
                            <p>
                              {face?.manifest.name ?? "Unknown face"}
                              <span className="text-dot">·</span>
                              {device.timezone.replaceAll("_", " ")}
                            </p>
                          </div>
                          <button
                            className="icon-button"
                            aria-label={`Configure ${device.name}`}
                            onClick={() => setEditing(device)}
                          >
                            <Icon name="settings" />
                          </button>
                        </div>
                        <div className="device-footer">
                          <button
                            className="text-button"
                            aria-label={`Display link for ${device.name}`}
                            onClick={() =>
                              setDisplayLink(
                                location.origin + device.displayUrl,
                              )
                            }
                          >
                            <Icon name="link" />
                            Display link
                          </button>
                          <button
                            className="text-button subdued"
                            aria-label={`Remove ${device.name}`}
                            onClick={() =>
                              setRemoving({
                                id: device.id,
                                name: device.name,
                                type: "devices",
                              })
                            }
                          >
                            Remove
                          </button>
                        </div>
                      </article>
                    );
                  })}
                  <button className="add-card" onClick={() => setAdding(true)}>
                    <span className="add-circle">
                      <Icon name="plus" />
                    </span>
                    <strong>Room for one more?</strong>
                    <span>Give another screen a little life.</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="section-title">
                <h2>
                  Your collection <span>{faces.length}</span>
                </h2>
                <span className="muted">
                  Locally installed. Ready to make yours.
                </span>
              </div>
              <div className="face-grid">
                {faces.map((face) => (
                  <article className="library-card" key={face.manifest.id}>
                    <div className="library-preview">
                      <FaceFrame
                        face={face.manifest}
                        settings={validateSettings(face.manifest, {})}
                        timezone={localTimezone}
                      />
                      <span className="face-tag">
                        {face.builtin ? "THE ORIGINALS" : "INSTALLED"}
                      </span>
                    </div>
                    <div className="library-info">
                      <div>
                        <h3>{face.manifest.name}</h3>
                        <span className="muted">
                          by {face.manifest.author ?? "Independent creator"}{" "}
                          <span className="text-dot">·</span> v
                          {face.manifest.version}
                        </span>
                      </div>
                      <p>{face.manifest.description}</p>
                      <div className="library-footer">
                        <span>
                          {face.manifest.settings.length} ways to make it yours
                        </span>
                        {!face.builtin && (
                          <button
                            className="text-button"
                            onClick={() =>
                              setRemoving({
                                id: face.manifest.id,
                                name: face.manifest.name,
                                type: "faces",
                              })
                            }
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>Beautiful screens for idle devices.</span>
            <span>Slow down. Look up. Stay a while.</span>
          </footer>
        </div>
      </main>
      <input
        ref={input}
        type="file"
        accept=".zip,application/zip"
        hidden
        aria-label="Face ZIP package"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            if (file.size > 10 * 1024 * 1024)
              setError("ZIP packages must be 10 MiB or smaller.");
            else setInstalling(file);
          }
          event.target.value = "";
        }}
      />
      {notice && (
        <div className="toast" role="status">
          {notice}
        </div>
      )}
      {adding && (
        <AddDevice
          faces={faces}
          onClose={() => setAdding(false)}
          onCreate={async (body) => {
            const result = await api<{ displayUrl: string }>("/api/devices", {
              method: "POST",
              body: JSON.stringify(body),
            });
            await load();
            setAdding(false);
            setDisplayLink(location.origin + result.displayUrl);
          }}
        />
      )}
      {editing && (
        <DeviceEditor
          key={editing.id}
          device={editing}
          faces={faces}
          onClose={() => setEditing(undefined)}
          onSave={async (body) => {
            await api(`/api/devices/${editing.id}`, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
            await load();
            setNotice("A fresh mood, delivered.");
          }}
        />
      )}
      {displayLink && (
        <DisplayLink url={displayLink} onClose={() => setDisplayLink("")} />
      )}
      {installing && (
        <Install
          file={installing}
          onClose={() => setInstalling(undefined)}
          onInstall={async () => {
            const form = new FormData();
            form.append("package", installing);
            await api("/api/faces", { method: "POST", body: form });
            await load();
            setInstalling(undefined);
            setNotice("A new face has joined your collection.");
          }}
        />
      )}
      {removing && (
        <Dialog
          title={`Remove ${removing.name}?`}
          onClose={() => {
            if (!removeBusy) setRemoving(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              {removing.type === "devices"
                ? "This removes the display and its settings. Its address will stop working."
                : "Switch any displays using this face to another face first. Its package will be deleted."}
            </p>
            <button
              className="danger"
              disabled={removeBusy}
              onClick={() => {
                setRemoveBusy(true);
                void api(`/api/${removing.type}/${removing.id}`, {
                  method: "DELETE",
                })
                  .then(async () => {
                    await load();
                    setRemoving(undefined);
                    setNotice("Removed from your space.");
                  })
                  .catch((error) => {
                    setError(errorMessage(error));
                    setRemoving(undefined);
                  })
                  .finally(() => setRemoveBusy(false));
              }}
            >
              {removeBusy ? "Removing…" : "Yes, remove"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
