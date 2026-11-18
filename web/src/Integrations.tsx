import { useState, type FormEvent } from "react";
import type { Integration } from "../../src/shared/face-data.js";
import { api, errorMessage } from "./api.js";
import { Dialog } from "./Dialog.js";
import { Select } from "./Select.js";

function IntegrationEditor({
  integration,
  onlineBackgroundsExists,
  onClose,
  onSaved,
}: {
  integration: Integration | null;
  onlineBackgroundsExists: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(integration?.name ?? "Home Assistant");
  const [type, setType] = useState<Integration["type"]>(
    integration?.type ?? "home-assistant",
  );
  const [baseUrl, setBaseUrl] = useState(
    integration &&
      (integration.type === "home-assistant" || integration.type === "immich")
      ? integration.baseUrl
      : "",
  );
  const [folder, setFolder] = useState(
    integration?.type === "mounted-folder" ? integration.folder : "",
  );
  const [token, setToken] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [timezone, setTimezone] = useState(
    integration?.type === "ical"
      ? integration.timezone
      : Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [enabled, setEnabled] = useState(integration?.enabled ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const provider =
    type === "online-backgrounds"
      ? "Online backgrounds"
      : type === "ical"
        ? "iCalendar"
        : type === "immich"
          ? "Immich"
          : "Home Assistant";
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
            ...(type === "online-backgrounds"
              ? {}
              : type === "ical"
                ? { timezone, ...(feedUrl ? { feedUrl } : {}) }
                : type === "mounted-folder"
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
            ...(type === "online-backgrounds"
              ? {}
              : type === "ical"
                ? { timezone, ...(feedUrl ? { feedUrl } : {}) }
                : type === "mounted-folder"
                  ? { folder }
                  : { baseUrl }),
            enabled,
            ...((type === "home-assistant" || type === "immich") && token
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
              { value: "online-backgrounds", label: "Online backgrounds" },
              { value: "ical", label: "iCalendar feed" },
            ].filter(
              (option) =>
                option.value !== "online-backgrounds" ||
                !onlineBackgroundsExists,
            )}
            onChange={(value) => {
              setType(value as Integration["type"]);
              setBaseUrl("");
              setToken("");
              setFeedUrl("");
              setFolder("");
              setName(
                value === "online-backgrounds"
                  ? "Online backgrounds"
                  : value === "mounted-folder"
                    ? "Photo folders"
                    : value === "ical"
                      ? "Calendar"
                      : value === "immich"
                        ? "Immich"
                        : "Home Assistant",
              );
              setError("");
              setNotice("");
            }}
          />
        )}
        {type === "online-backgrounds" ? (
          <p>
            Wikimedia Commons and NASA albums. Enabled by default; requires
            internet access.
          </p>
        ) : type === "ical" ? (
          <small>
            Subscription URLs are secrets, stored encrypted on the server.
          </small>
        ) : type === "immich" ? (
          <small>Requires Immich 3.4.1 or later in 3.x.</small>
        ) : null}
        <label>
          Connection name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        {type === "online-backgrounds" ? (
          <small>
            Third-party collections may include unsuitable content. Image
            credits are required.
          </small>
        ) : type === "ical" ? (
          <>
            <label>
              Subscription URL
              <input
                type="password"
                required={!integration}
                maxLength={2048}
                autoComplete="new-password"
                spellCheck={false}
                value={feedUrl}
                placeholder={
                  integration
                    ? "Leave blank to keep the saved URL"
                    : "https://…/calendar.ics"
                }
                onChange={(event) => setFeedUrl(event.target.value)}
              />
            </label>
            <small>Direct .ics URL; webcal:// is supported.</small>
            {feedUrl.startsWith("http:") && (
              <p className="integration-warning">
                HTTP exposes the secret feed URL and events. Prefer HTTPS.
              </p>
            )}
            <label>
              Calendar timezone
              <input
                required
                maxLength={100}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              />
            </label>
            <small>
              e.g. Europe/Helsinki. Used for events without a timezone.
            </small>
          </>
        ) : type === "mounted-folder" ? (
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
            <small>Relative to /photos; leave blank for all folders.</small>
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
                HTTP sends credentials unencrypted. Use only on a trusted
                network; prefer HTTPS.
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
                ? "Required permissions: album.read, asset.read, asset.view. Use an account with access only to intended albums."
                : "Tokens may allow more than read access. Use a dedicated, least-privilege account."}
            </small>
          </>
        )}
        <details className="help">
          <summary>Setup help</summary>
          <p>
            {type === "online-backgrounds"
              ? "Choose an album in a display’s Data sources. Only selected albums are fetched. No account or API key is required."
              : type === "ical"
                ? "Use a calendar subscription URL, not a web page. webcal:// uses HTTPS; redirects are not followed. Event timezones override the calendar timezone."
                : type === "mounted-folder"
                  ? "Mount photos read-only at /photos in Docker. Enter a relative folder, not a NAS address or host path. Subfolders are included. Supported formats: JPEG, PNG, WebP."
                  : type === "immich"
                    ? "Create an API key in Immich user settings. Write and original-download permissions are not needed. Choose an album in a display’s Data sources; faces never receive the key."
                    : "Create a long-lived access token in your Home Assistant profile under Security. Select sensors, weather, or calendars in a display’s Data sources; faces never receive the token."}
          </p>
        </details>
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
            Saving stops data on {integration.usage.length}{" "}
            {integration.usage.length === 1 ? "display" : "displays"}. Clocks
            keep running.
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
              (type === "ical"
                ? !timezone || (!integration && !feedUrl)
                : type !== "mounted-folder" &&
                  type !== "online-backgrounds" &&
                  (!baseUrl || (!integration && !token)))
            }
            onClick={() => void test()}
          >
            Test connection
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "Working…" : "Save integration"}
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
        <h1>Integrations</h1>
        <button className="primary" onClick={() => setEditing(null)}>
          Add integration
        </button>
      </section>
      {integrations.length === 0 && (
        <section className="empty-state integration-empty">
          <h2>No integrations</h2>
          <p>
            Add an integration to use photos, weather, sensors, or calendars.
          </p>
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
              {integration.type === "online-backgrounds"
                ? "Wikimedia Commons & NASA"
                : integration.type === "ical"
                  ? `iCalendar · ${integration.timezone}`
                  : integration.type === "home-assistant"
                    ? `Home Assistant · ${integration.baseUrl}`
                    : integration.type === "immich"
                      ? `Immich · ${integration.baseUrl}`
                      : `Mounted photos · ${integration.folder || "All folders"}`}
            </p>
            {integration.error && <p className="error">{integration.error}</p>}
            <div className="integration-usage">
              <small>{integration.usage.length ? "Used by" : "Not used"}</small>
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
                aria-label={`Configure ${integration.name}`}
                onClick={() => setEditing(integration)}
              >
                Configure
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
          onlineBackgroundsExists={integrations.some(
            (integration) => integration.type === "online-backgrounds",
          )}
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
                ? "Data will become unavailable. Faces keep running."
                : "Permanently deletes this connection and its credentials. Disconnect its sources from all displays and scenes first."}
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
                ? action.type === "disable"
                  ? "Disabling…"
                  : "Removing…"
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
