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
} from "../../src/shared/contracts.js";
import { api, ApiError, errorMessage, setCSRF } from "./api.js";
import { FaceFrame } from "./FaceFrame.js";
import { Select } from "./Select.js";
import { Dialog } from "./Dialog.js";
import { IntegrationsPage } from "./Integrations.js";
import { BindingFields, useDataPreview } from "./Bindings.js";
import type { Bindings, Integration } from "../../src/shared/face-data.js";
import { SettingField } from "./SettingField.js";
import { Scenes } from "./Scenes.js";

const localTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const zones = ["UTC", localTimezone, ...Intl.supportedValuesOf("timeZone")];
type Auth = { configured: boolean; authenticated: boolean; csrf?: string };
type IconName = "display" | "grid" | "plus" | "upload" | "settings" | "link";
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
    upload: (
      <>
        <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
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
      <section className="login-panel">
        <div className="brand">
          <span className="brand-symbol" />
          screensvr
        </div>
        <h1>{auth.configured ? "Sign in" : "Set up screensvr"}</h1>
        {!auth.configured && <p>Create an administrator password.</p>}
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
              aria-describedby={auth.configured ? undefined : "password-hint"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          {!auth.configured && (
            <small id="password-hint">At least 12 characters.</small>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary full-width" disabled={busy}>
            {busy
              ? auth.configured
                ? "Signing in…"
                : "Setting up…"
              : auth.configured
                ? "Sign in"
                : "Create password"}
          </button>
        </form>
        {!auth.configured && (
          <p className="fine-print">
            The first person to complete setup becomes the administrator. Set up
            on a trusted network.
          </p>
        )}
      </section>
    </main>
  );
}

function DeviceEditor({
  device,
  faces,
  integrations,
  onClose,
  onSave,
}: {
  device: Device;
  faces: Face[];
  integrations: Integration[];
  onClose: () => void;
  onSave: (body: object) => Promise<void>;
}) {
  const [name, setName] = useState(device.name);
  const [timezone, setTimezone] = useState(device.timezone);
  const [faceId, setFaceId] = useState(device.faceId);
  const [settings, setSettings] = useState<Settings>(device.settings);
  const [bindings, setBindings] = useState<Bindings>(device.bindings);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const face = faces.find((face) => face.manifest.id === faceId);
  const preview = useDataPreview(device.id, face?.manifest, bindings);
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
      await onSave(
        device.schedule.enabled
          ? { name, timezone, revision: device.revision }
          : {
              name,
              timezone,
              faceId,
              settings,
              bindings,
              revision: device.revision,
            },
      );
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="Display settings" onClose={onClose} wide>
      <div className="editor-layout">
        <section className="editor-preview">
          <div className="preview-screen">
            <FaceFrame
              face={face.manifest}
              settings={settings}
              timezone={previewTimezone}
              name={name}
              data={preview?.data}
            />
          </div>
          <span className="preview-label">Preview</span>
          {!device.schedule.enabled && <p>Changes apply when saved.</p>}
          {preview?.error && (
            <p className="error" role="alert">
              {preview.error}
            </p>
          )}
        </section>
        <form className="editor-form" onSubmit={(event) => void submit(event)}>
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
          {device.schedule.enabled ? (
            <p>
              Schedule enabled. Edit faces and data sources in Scenes &amp;
              schedule.
            </p>
          ) : (
            <>
              <Select
                label="Face"
                value={faceId}
                onChange={(value) => {
                  setFaceId(value);
                  setBindings({});
                  setSettings(
                    validateSettings(
                      faces.find((face) => face.manifest.id === value)!
                        .manifest,
                      {},
                    ),
                  );
                }}
                options={faces.map((face) => ({
                  value: face.manifest.id,
                  label: face.manifest.name,
                }))}
              />
              {faceId !== device.faceId && (
                <p className="integration-warning">
                  Saving clears the previous face’s settings and data sources.
                </p>
              )}
              {face.manifest.settings.length > 0 && (
                <>
                  <div className="form-divider" />
                  <h3 className="form-section-title">Appearance</h3>
                </>
              )}
              {face.manifest.settings.map((setting) => (
                <SettingField
                  key={setting.key}
                  setting={setting}
                  value={settings[setting.key] ?? setting.default}
                  onChange={(value) =>
                    setSettings((current) => ({
                      ...current,
                      [setting.key]: value,
                    }))
                  }
                />
              ))}
              <BindingFields
                face={face.manifest}
                bindings={bindings}
                integrations={integrations}
                onChange={setBindings}
              />
            </>
          )}
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
    <Dialog title="Add display" onClose={onClose}>
      <form className="dialog-body" onSubmit={(event) => void submit(event)}>
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
          label="Face"
          value={faceId}
          onChange={setFaceId}
          options={faces.map((face) => ({
            value: face.manifest.id,
            label: face.manifest.name,
          }))}
        />
        <small>Timezone: {localTimezone}</small>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary full-width" disabled={busy}>
          {busy ? "Creating…" : "Create display"}
        </button>
      </form>
    </Dialog>
  );
}

function DisplayLink({ url, onClose }: { url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog title="Display link" onClose={onClose}>
      <div className="dialog-body">
        <p>Open this URL in your display’s browser.</p>
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
            {copied ? "Copied" : "Copy link"}
          </button>
          <a className="primary" href={url} target="_blank" rel="noreferrer">
            Open display
          </a>
        </div>
        <small>
          Renaming won’t change this URL. Anyone who can reach the server can
          view it.
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
    <Dialog title="Install face" onClose={onClose}>
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
          Face packages run JavaScript. Only install packages from sources you
          trust; sandboxing does not make untrusted code safe.
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
        </button>
      </form>
    </Dialog>
  );
}

export function App() {
  const [auth, setAuth] = useState<Auth>();
  const [faces, setFaces] = useState<Face[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [page, setPage] = useState<"displays" | "faces" | "integrations">(
    "displays",
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Device>();
  const [scenesFor, setScenesFor] = useState<Device>();
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
      const [nextFaces, nextDevices, nextIntegrations] = await Promise.all([
        api<Face[]>("/api/faces"),
        api<Device[]>("/api/devices"),
        api<Integration[]>("/api/integrations"),
      ]);
      setFaces(nextFaces);
      setDevices(nextDevices);
      setIntegrations(nextIntegrations);
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
        <p>{error || "Loading…"}</p>
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
          <button
            className={page === "integrations" ? "active" : ""}
            onClick={() => setPage("integrations")}
          >
            <Icon name="link" />
            Integrations<span className="nav-count">{integrations.length}</span>
          </button>
        </nav>
        <div className="sidebar-footer">
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
      </aside>
      <main className="main-content">
        <div className="page-content">
          {error && (
            <div className="error banner" role="alert">
              {error}
              <button className="text-button" onClick={() => setError("")}>
                Dismiss
              </button>
            </div>
          )}
          {page !== "integrations" && (
            <section className="page-heading">
              <div>
                <h1>{page === "displays" ? "Displays" : "Face library"}</h1>
                {page === "displays" && devices.length > 0 && (
                  <p>
                    {online} online <span className="text-dot">·</span>{" "}
                    {devices.length - online} offline
                  </p>
                )}
              </div>
              <button
                className="primary"
                onClick={() =>
                  page === "displays" ? setAdding(true) : input.current?.click()
                }
              >
                <Icon name={page === "displays" ? "plus" : "upload"} />
                {page === "displays" ? "Add display" : "Install face"}
              </button>
            </section>
          )}
          {page === "integrations" ? (
            <IntegrationsPage
              integrations={integrations}
              onChanged={load}
              onConfigure={(id) => {
                setPage("displays");
                setEditing(devices.find((device) => device.id === id));
              }}
            />
          ) : page === "displays" ? (
            <>
              {devices.length === 0 ? (
                <section className="empty-state">
                  <h2>No displays</h2>
                  <p>
                    Add a display to get a URL for your tablet, monitor, or
                    kiosk.
                  </p>
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
                              data={device.data}
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
                            <h2>{device.name}</h2>
                            <p>
                              {face?.manifest.name ?? "Unknown face"}
                              <span className="text-dot">·</span>
                              {device.timezone.replaceAll("_", " ")}
                            </p>
                            {(device.schedule.enabled ||
                              device.scenes.length > 1) && (
                              <p>
                                {
                                  device.scenes.find(
                                    (scene) =>
                                      scene.id === device.activeSceneId,
                                  )?.name
                                }
                                {device.schedule.enabled
                                  ? " · Scheduled"
                                  : " · Manual"}
                              </p>
                            )}
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
                            aria-label={`Scenes & schedule for ${device.name}`}
                            onClick={() => setScenesFor(device)}
                          >
                            Scenes &amp; schedule
                          </button>
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
                </div>
              )}
            </>
          ) : (
            <>
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
                        {face.builtin ? "Built-in" : "Installed"}
                      </span>
                    </div>
                    <div className="library-info">
                      <div>
                        <h2>{face.manifest.name}</h2>
                        <span className="muted">
                          {face.manifest.author && (
                            <>
                              {face.manifest.author}
                              <span className="text-dot">·</span>
                            </>
                          )}
                          v{face.manifest.version}
                        </span>
                      </div>
                      <p>{face.manifest.description}</p>
                      {!face.builtin && (
                        <div className="library-footer">
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
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
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
          integrations={integrations}
          onClose={() => setEditing(undefined)}
          onSave={async (body) => {
            await api(`/api/devices/${editing.id}`, {
              method: "PATCH",
              body: JSON.stringify(body),
            });
            await load();
            setNotice("Changes saved");
          }}
        />
      )}
      {scenesFor && (
        <Scenes
          device={scenesFor}
          faces={faces}
          integrations={integrations}
          onClose={() => setScenesFor(undefined)}
          onChanged={load}
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
            setNotice("Face installed");
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
                    setNotice(
                      removing.type === "devices"
                        ? "Display removed"
                        : "Face removed",
                    );
                  })
                  .catch((error) => {
                    setError(errorMessage(error));
                    setRemoving(undefined);
                  })
                  .finally(() => setRemoveBusy(false));
              }}
            >
              {removeBusy
                ? "Removing…"
                : removing.type === "devices"
                  ? "Remove display"
                  : "Remove face"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
