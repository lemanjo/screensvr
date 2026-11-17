import { useState, type FormEvent } from "react";
import type { Integration } from "../../src/shared/face-data.js";
import { api, errorMessage } from "./api.js";
import { Dialog } from "./Dialog.js";
import { Select } from "./Select.js";

function IntegrationEditor({
  integration,
  onClose,
  onSaved,
}: {
  integration: Integration | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(integration?.name ?? "Home Assistant");
  const [type, setType] = useState<Integration["type"]>(
    integration?.type ?? "home-assistant",
  );
  const [baseUrl, setBaseUrl] = useState(
    integration && integration.type !== "mounted-folder"
      ? integration.baseUrl
      : "",
  );
  const [folder, setFolder] = useState(
    integration?.type === "mounted-folder" ? integration.folder : "",
  );
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const provider = type === "immich" ? "Immich" : "Home Assistant";
  async function test() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(
        integration
          ? `/api/integrations/${integration.id}/test`
          : "/api/integrations/test",
        {
          method: "POST",
          body: JSON.stringify({
            ...(integration ? {} : { type }),
            ...(type === "mounted-folder"
              ? { folder }
              : { baseUrl, ...(token ? { token: token.trim() } : {}) }),
          }),
        },
      );
      setNotice("Connection successful.");
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(
        integration
          ? `/api/integrations/${integration.id}`
          : "/api/integrations",
        {
          method: integration ? "PATCH" : "POST",
          body: JSON.stringify({
            ...(integration ? { revision: integration.revision } : { type }),
            name,
            ...(type === "mounted-folder" ? { folder } : { baseUrl }),
            enabled,
            ...(type !== "mounted-folder" && token
              ? { token: token.trim() }
              : {}),
          }),
        },
      );
      await onSaved();
      onClose();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={
        integration
          ? `Edit ${type === "mounted-folder" ? "mounted folders" : provider}`
          : "Add integration"
      }
      onClose={onClose}
    >
      <form
        className="dialog-body integration-form"
        onSubmit={(event) => void save(event)}
      >
        {!integration && (
          <Select
            label="Integration type"
            value={type}
            options={[
              { value: "home-assistant", label: "Home Assistant" },
              { value: "mounted-folder", label: "Mounted photo folders" },
              { value: "immich", label: "Immich" },
            ]}
            onChange={(value) => {
              setType(value as Integration["type"]);
              setBaseUrl("");
              setToken("");
              setFolder("");
              setName(
                value === "mounted-folder"
                  ? "Photo folders"
                  : value === "immich"
                    ? "Immich"
                    : "Home Assistant",
              );
              setError("");
              setNotice("");
            }}
          />
        )}
        <p>
          {type === "mounted-folder"
            ? "Read photos from your server’s photo directory. Choose a folder or individual image separately for each display."
            : type === "immich"
              ? "Connect Immich 3.4.1 or newer in 3.x, then choose an album separately for each display. Faces never receive your API key."
              : "Connect once, then choose which sensors each display receives. Faces never receive your access token."}
        </p>
        <label>
          Connection name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {type === "mounted-folder" ? (
          <>
            <label>
              Folder inside photo directory
              <input
                maxLength={200}
                placeholder="e.g. family (blank for all folders)"
                value={folder}
                onChange={(event) => setFolder(event.target.value)}
              />
            </label>
            <small>
              Mount your photos read-only at /photos in Docker. Use a relative
              folder here, not a NAS address or host path. Subfolders are
              included. JPEG, PNG, and WebP are supported.
            </small>
          </>
        ) : (
          <>
            <label>
              {provider} URL
              <input
                required
                type="url"
                maxLength={2048}
                placeholder={
                  type === "immich"
                    ? "http://immich.local:2283"
                    : "http://homeassistant.local:8123"
                }
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
              />
            </label>
            {baseUrl.startsWith("http:") && (
              <p className="integration-warning">
                HTTP sends your credentials without encryption. Use it only on a
                trusted network; prefer HTTPS.
              </p>
            )}
            <label>
              {type === "immich" ? "API key" : "Long-lived access token"}
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                required={!integration}
                maxLength={4096}
                value={token}
                placeholder={
                  integration
                    ? `Leave blank to keep the saved ${type === "immich" ? "API key" : "token"}`
                    : ""
                }
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <small>
              {type === "immich"
                ? "Create an API key in Immich user settings with album.read, asset.read, and asset.view permissions. No write or original-download permissions are needed. Prefer a dedicated account shared only into intended albums."
                : "Create a long-lived access token in your Home Assistant profile under Security. Prefer a dedicated, least-privilege account. screensvr only reads data, but the token may permit other operations."}
            </small>
          </>
        )}
        <label className="toggle-field">
          <span>Enabled</span>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
        </label>
        {integration?.enabled && !enabled && (
          <p className="integration-warning">
            Saving will stop data on {integration.usage.length} display(s).
            Their clocks will keep running.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={
              busy ||
              (type !== "mounted-folder" &&
                (!baseUrl || (!integration && !token)))
            }
            onClick={() => void test()}
          >
            Test connection
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "One moment…" : "Save integration"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

const statusLabels: Record<Integration["status"], string> = {
  connecting: "Connecting",
  connected: "Connected",
  disconnected: "Reconnecting",
  "authentication-error": "Check credentials",
  error: "Needs attention",
  disabled: "Disabled",
};
export function IntegrationsPage({
  integrations,
  onChanged,
  onConfigure,
}: {
  integrations: Integration[];
  onChanged: () => Promise<void>;
  onConfigure: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Integration | null>();
  const [action, setAction] = useState<{
    integration: Integration;
    type: "disable" | "remove";
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function confirm() {
    if (!action) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/integrations/${action.integration.id}`, {
        method: action.type === "remove" ? "DELETE" : "PATCH",
        ...(action.type === "disable"
          ? {
              body: JSON.stringify({
                revision: action.integration.revision,
                enabled: false,
              }),
            }
          : {}),
      });
      await onChanged();
      setAction(undefined);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="page-heading">
        <div>
          <span className="eyebrow">A LITTLE MORE CONTEXT.</span>
          <h1>Your home, at a glance.</h1>
          <p>Connect your services. Share only the data your faces need.</p>
        </div>
        <button className="primary" onClick={() => setEditing(null)}>
          Add integration
        </button>
      </section>
      {integrations.length === 0 && (
        <section className="empty-state integration-empty">
          <div>
            <h2>A connection to your home.</h2>
            <p>
              Add Home Assistant, Immich, or mounted photo folders, then choose
              a source in a display’s settings.
            </p>
            <button className="primary" onClick={() => setEditing(null)}>
              Add your first integration
            </button>
          </div>
        </section>
      )}
      <div className="integration-grid">
        {integrations.map((integration) => (
          <article className="integration-card" key={integration.id}>
            <div className="section-title">
              <h2>{integration.name}</h2>
              <span
                className={`integration-status ${integration.status === "connected" ? "is-connected" : ""}`}
              >
                {statusLabels[integration.status]}
              </span>
            </div>
            <p className="muted">
              {integration.type === "home-assistant"
                ? `Home Assistant · ${integration.baseUrl}`
                : integration.type === "immich"
                  ? `Immich · ${integration.baseUrl}`
                  : `Mounted photos · ${integration.folder || "All folders"}`}
            </p>
            {integration.error && <p className="error">{integration.error}</p>}
            <div className="integration-usage">
              <small>
                {integration.usage.length
                  ? "Used by"
                  : "Not yet connected to a display"}
              </small>
              {integration.usage.map((device) => (
                <button
                  key={device.id}
                  className="text-button"
                  onClick={() => onConfigure(device.id)}
                >
                  {device.name}
                </button>
              ))}
            </div>
            <div className="form-actions">
              <button
                className="secondary"
                onClick={() => setEditing(integration)}
              >
                Configure {integration.name}
              </button>
              {integration.enabled && (
                <button
                  className="text-button"
                  onClick={() => {
                    setError("");
                    setAction({ integration, type: "disable" });
                  }}
                >
                  Disable
                </button>
              )}
              <button
                className="text-button subdued"
                onClick={() => {
                  setError("");
                  setAction({ integration, type: "remove" });
                }}
              >
                Remove
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing !== undefined && (
        <IntegrationEditor
          key={editing?.id ?? "new"}
          integration={editing}
          onClose={() => setEditing(undefined)}
          onSaved={onChanged}
        />
      )}
      {action && (
        <Dialog
          title={`${action.type === "disable" ? "Disable" : "Remove"} ${action.integration.name}?`}
          onClose={() => {
            if (!busy) setAction(undefined);
          }}
        >
          <div className="dialog-body">
            <p>
              {action.type === "disable"
                ? "Selected readings will become unavailable. Your faces will keep running."
                : "This permanently removes the connection and its saved credentials. Unbind its sources from every display first."}
            </p>
            {action.integration.usage.length > 0 && (
              <p>
                Affected displays:{" "}
                {action.integration.usage
                  .map((device) => device.name)
                  .join(", ")}
                .
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              className="danger"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {busy
                ? "One moment…"
                : action.type === "disable"
                  ? "Disable integration"
                  : "Remove integration"}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
