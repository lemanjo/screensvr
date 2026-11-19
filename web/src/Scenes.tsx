import { useEffect, useState } from "react";
import {
  validateSettings,
  type Device,
  type Face,
} from "../../src/shared/contracts.js";
import {
  scheduleSchema,
  type Scene,
  type SceneConfiguration,
  type Schedule,
} from "../../src/shared/scenes.js";
import type { Integration } from "../../src/shared/face-data.js";
import { api, errorMessage } from "./api.js";
import { Dialog } from "./Dialog.js";
import { Select } from "./Select.js";
import { SettingField } from "./SettingField.js";
import { FaceFrame } from "./FaceFrame.js";
import { BindingFields, useDataPreview } from "./Bindings.js";

const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function SceneEditor({
  scene,
  device,
  faces,
  integrations,
  active,
  busy,
  onSave,
}: {
  scene: Scene;
  device: Device;
  faces: Face[];
  integrations: Integration[];
  active: boolean;
  busy: boolean;
  onSave: (scene: Scene) => void;
}) {
  const [draft, setDraft] = useState(scene);
  const face = faces.find((face) => face.manifest.id === draft.faceId);
  const preview = useDataPreview(
    device.id,
    face?.manifest,
    draft.bindings,
    scene.id,
  );
  if (!face) return <p>This face is no longer installed.</p>;
  return (
    <div className="editor-layout">
      <section className="editor-preview">
        <div className="preview-screen">
          <FaceFrame
            face={face.manifest}
            settings={draft.settings}
            timezone={device.timezone}
            name={device.name}
            data={preview?.data}
          />
        </div>
        <span className="preview-label">Preview</span>
        <p>
          {active
            ? "Changes apply when saved."
            : "Saving won’t activate this scene."}
        </p>
        {preview?.error && (
          <p className="error" role="alert">
            {preview.error}
          </p>
        )}
      </section>
      <form
        className="editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSave(draft);
        }}
      >
        <label>
          Scene name
          <input
            required
            maxLength={80}
            value={draft.name}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
          />
        </label>
        <Select
          label="Face"
          value={draft.faceId}
          options={faces.map((face) => ({
            value: face.manifest.id,
            label: face.manifest.name,
          }))}
          onChange={(faceId) => {
            setDraft({
              ...draft,
              faceId,
              settings: validateSettings(
                faces.find((face) => face.manifest.id === faceId)!.manifest,
                {},
              ),
              bindings: {},
            });
          }}
        />
        {draft.faceId !== scene.faceId && (
          <p className="integration-warning">
            Saving clears this scene’s previous settings and data sources.
          </p>
        )}
        {face.manifest.settings.map((setting) => (
          <SettingField
            key={setting.key}
            setting={setting}
            value={draft.settings[setting.key] ?? setting.default}
            onChange={(value) =>
              setDraft((current) => ({
                ...current,
                settings: { ...current.settings, [setting.key]: value },
              }))
            }
          />
        ))}
        <BindingFields
          face={face.manifest}
          bindings={draft.bindings}
          integrations={integrations}
          onChange={(bindings) => setDraft({ ...draft, bindings })}
        />
        <button className="primary" disabled={busy}>
          {busy ? "Saving…" : "Save scene"}
        </button>
      </form>
    </div>
  );
}

function ScheduleEditor({
  config,
  busy,
  onSave,
}: {
  config: SceneConfiguration;
  busy: boolean;
  onSave: (schedule: Schedule) => void;
}) {
  const [draft, setDraft] = useState(config.schedule);
  const parsed = scheduleSchema.safeParse(draft);
  function update(index: number, patch: Partial<Schedule["entries"][number]>) {
    setDraft({
      ...draft,
      entries: draft.entries.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    });
  }
  return (
    <form
      className="schedule-editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.success) onSave(parsed.data);
      }}
    >
      <label className="toggle-field">
        Enable scheduling
        <input
          type="checkbox"
          checked={draft.enabled}
          onChange={(event) =>
            setDraft({ ...draft, enabled: event.target.checked })
          }
        />
      </label>
      <p>
        Scenes stay active until the next entry. Disabling scheduling keeps the
        current scene.
      </p>
      {draft.entries.map((entry, index) => (
        <fieldset className="schedule-entry" key={index}>
          <legend>Entry {index + 1}</legend>
          <div className="weekday-picker">
            {weekdays.map((day, i) => (
              <label key={day}>
                <input
                  type="checkbox"
                  aria-label={`Entry ${index + 1} ${day}`}
                  checked={entry.days.includes(i + 1)}
                  onChange={(event) =>
                    update(index, {
                      days: event.target.checked
                        ? [...entry.days, i + 1].sort()
                        : entry.days.filter((value) => value !== i + 1),
                    })
                  }
                />
                {day}
              </label>
            ))}
          </div>
          <label>
            Start time
            <input
              type="time"
              required
              aria-label={`Entry ${index + 1} start time`}
              value={entry.time}
              onChange={(event) => update(index, { time: event.target.value })}
            />
          </label>
          <Select
            label={`Entry ${index + 1} scene`}
            value={entry.sceneId}
            options={config.scenes.map((scene) => ({
              value: scene.id,
              label: scene.name,
            }))}
            onChange={(sceneId) => update(index, { sceneId })}
          />
          <button
            type="button"
            className="text-button"
            onClick={() =>
              setDraft({
                ...draft,
                entries: draft.entries.filter((_, i) => i !== index),
              })
            }
          >
            Remove entry {index + 1}
          </button>
        </fieldset>
      ))}
      <button
        type="button"
        className="secondary"
        disabled={draft.entries.length >= 64 || busy}
        onClick={() =>
          setDraft({
            ...draft,
            entries: [
              ...draft.entries,
              {
                days: [1, 2, 3, 4, 5, 6, 7],
                time: "07:00",
                sceneId: config.scenes[0].id,
              },
            ],
          })
        }
      >
        Add schedule entry
      </button>
      {!parsed.success && (
        <p className="error" role="alert">
          {parsed.error.issues.map((issue) => issue.message).join(" ")}
        </p>
      )}
      <details className="help">
        <summary>Schedule details</summary>
        <p>
          Scenes carry over overnight and on days without entries. Disable
          scheduling to activate a scene manually.
        </p>
        <p>
          When clocks move forward, skipped entries apply at the clock jump; the
          latest wins. When an hour repeats, entries apply only at the first
          occurrence.
        </p>
      </details>
      <button className="primary" disabled={busy || !parsed.success}>
        {busy ? "Saving…" : "Save schedule"}
      </button>
    </form>
  );
}

export function Scenes({
  device,
  faces,
  integrations,
  onClose,
  onChanged,
}: {
  device: Device;
  faces: Face[];
  integrations: Integration[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [config, setConfig] = useState<SceneConfiguration>(device);
  const [selected, setSelected] = useState(device.activeSceneId);
  const [tab, setTab] = useState<"scenes" | "schedule">("scenes");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState("");
  const base = `/api/devices/${device.id}`;
  useEffect(() => {
    const controller = new AbortController();
    void api<SceneConfiguration>(`${base}/scenes`, {
      signal: controller.signal,
    })
      .then(setConfig)
      .catch((error) => {
        if (!controller.signal.aborted) setError(errorMessage(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [base]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setInterval(() => {
      void api<SceneConfiguration>(`${base}/scenes`, {
        signal: controller.signal,
      })
        .then((next) => {
          setConfig((current) =>
            current.revision === next.revision
              ? {
                  ...current,
                  activeSceneId: next.activeSceneId,
                  nextTransition: next.nextTransition,
                }
              : current,
          );
        })
        .catch(() => {});
    }, 15000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [base]);
  async function mutate(path: string, method: string, body: object) {
    setBusy(true);
    setError("");
    try {
      const next = await api<SceneConfiguration & { createdSceneId?: string }>(
        `${base}${path}`,
        {
          method,
          body: JSON.stringify({ ...body, revision: config.revision }),
        },
      );
      setConfig(next);
      setDeleting("");
      if (next.createdSceneId) setSelected(next.createdSceneId);
      else if (!next.scenes.some((scene) => scene.id === selected))
        setSelected(next.activeSceneId);
      await onChanged();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  const current = config.scenes.find((scene) => scene.id === selected);
  const active = config.scenes.find(
    (scene) => scene.id === config.activeSceneId,
  );
  return (
    <Dialog title={`Scenes & schedule · ${device.name}`} onClose={onClose} wide>
      <div className="scene-manager">
        <p>
          Current scene: <strong>{active?.name}</strong> ·{" "}
          {config.schedule.enabled ? "Scheduled" : "Manual"} ·{" "}
          {device.timezone.replaceAll("_", " ")}
        </p>
        {config.nextTransition && (
          <p>
            Next:{" "}
            {
              config.scenes.find(
                (scene) => scene.id === config.nextTransition!.sceneId,
              )?.name
            }{" "}
            ·{" "}
            {new Intl.DateTimeFormat(undefined, {
              timeZone: device.timezone,
              weekday: "short",
              hour: "2-digit",
              minute: "2-digit",
            }).format(config.nextTransition.at)}
          </p>
        )}
        <div className="scene-actions">
          <button
            className={tab === "scenes" ? "primary" : "secondary"}
            onClick={() => setTab("scenes")}
          >
            Scenes
          </button>
          <button
            className={tab === "schedule" ? "primary" : "secondary"}
            onClick={() => setTab("schedule")}
          >
            Weekly schedule
          </button>
        </div>
        {error && (
          <div className="error" role="alert">
            {error}
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                void api<SceneConfiguration>(`${base}/scenes`)
                  .then((next) => {
                    setConfig(next);
                    setError("");
                    if (!next.scenes.some((scene) => scene.id === selected))
                      setSelected(next.activeSceneId);
                  })
                  .catch((error) => setError(errorMessage(error)));
              }}
            >
              Reload scenes
            </button>
          </div>
        )}
        {tab === "schedule" ? (
          <ScheduleEditor
            key={config.revision}
            config={config}
            busy={busy}
            onSave={(schedule) => void mutate("/schedule", "PUT", { schedule })}
          />
        ) : (
          <>
            <div className="scene-actions">
              <button
                className="secondary"
                disabled={busy || config.scenes.length >= 32}
                onClick={() =>
                  void mutate("/scenes", "POST", {
                    name: "New scene",
                    faceId: "builtin-digital",
                  })
                }
              >
                New scene
              </button>
              <button
                className="secondary"
                disabled={busy || config.scenes.length >= 32}
                onClick={() =>
                  void mutate("/scenes", "POST", {
                    name: "Night clock",
                    faceId: "builtin-digital",
                    settings: { nightMode: true },
                  })
                }
              >
                Add night clock
              </button>
            </div>
            <Select
              label="Saved scene"
              value={selected}
              onChange={(value) => {
                setSelected(value);
                setDeleting("");
              }}
              options={config.scenes.map((scene) => ({
                value: scene.id,
                label: `${scene.name}${scene.id === config.activeSceneId ? " · Current" : ""}`,
              }))}
            />
            {current && (
              <>
                <div className="scene-actions">
                  <button
                    className="secondary"
                    disabled={
                      busy ||
                      config.schedule.enabled ||
                      selected === config.activeSceneId
                    }
                    onClick={() =>
                      void mutate(`/scenes/${selected}/activate`, "POST", {})
                    }
                  >
                    Activate scene
                  </button>
                  <button
                    className="secondary"
                    disabled={busy || config.scenes.length >= 32}
                    onClick={() =>
                      void mutate("/scenes", "POST", {
                        name: `Copy of ${current.name}`.slice(0, 80),
                        copyFrom: selected,
                      })
                    }
                  >
                    Duplicate scene
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || config.scenes.length === 1}
                    onClick={() => setDeleting(selected)}
                  >
                    Delete scene
                  </button>
                </div>
                {config.schedule.enabled && (
                  <p>Disable scheduling before manually activating a scene.</p>
                )}
                {deleting === selected && (
                  <p>
                    Delete “{current.name}”?{" "}
                    <button
                      className="danger"
                      disabled={busy}
                      onClick={() =>
                        void mutate(`/scenes/${selected}`, "DELETE", {})
                      }
                    >
                      Confirm delete
                    </button>{" "}
                    <button
                      className="secondary"
                      onClick={() => setDeleting("")}
                    >
                      Cancel
                    </button>
                  </p>
                )}
                <SceneEditor
                  key={`${selected}/${config.revision}`}
                  scene={current}
                  device={device}
                  faces={faces}
                  integrations={integrations}
                  active={selected === config.activeSceneId}
                  busy={busy}
                  onSave={(scene) =>
                    void mutate(`/scenes/${scene.id}`, "PATCH", {
                      name: scene.name,
                      faceId: scene.faceId,
                      settings: scene.settings,
                      bindings: scene.bindings,
                    })
                  }
                />
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
