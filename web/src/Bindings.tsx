import { useEffect, useState } from "react";
import type { FaceManifest } from "../../src/shared/contracts.js";
import {
  compatible,
  isCalendarBinding,
  type Bindings,
  type FaceData,
  type FaceInput,
  type Integration,
  type Source,
  type SourceBinding,
  type CalendarBinding,
} from "../../src/shared/face-data.js";
import { api, errorMessage } from "./api.js";
import { Select } from "./Select.js";

function BindingField({
  input,
  binding,
  integrations,
  onChange,
}: {
  input: FaceInput;
  binding?: SourceBinding;
  integrations: Integration[];
  onChange: (binding?: SourceBinding) => void;
}) {
  const [integrationId, setIntegrationId] = useState(
    binding?.integrationId ?? "",
  );
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(100);
  const [total, setTotal] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setSources([]);
    setError("");
    setTotal(0);
    setLoading(false);
    if (!integrationId) return;
    setLoading(true);
    const timer = setTimeout(() => {
      void api<{ sources: Source[]; total: number }>(
        `/api/integrations/${integrationId}/sources?q=${encodeURIComponent(query)}&limit=${limit}&type=${input.type}${input.type === "number" && input.quantity ? `&quantity=${input.quantity}` : ""}${input.type === "forecast" ? `&period=${input.period}` : ""}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (!controller.signal.aborted) {
            setSources(result.sources);
            setTotal(result.total);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) setError(errorMessage(error));
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    integrationId,
    query,
    limit,
    input.type,
    input.type === "number" ? input.quantity : undefined,
    input.type === "forecast" ? input.period : undefined,
  ]);
  const matching = sources.filter((source) => compatible(input, source));
  const options = [
    { value: "", label: "Not connected" },
    ...matching.map((source) => ({
      value: source.id,
      label: `${source.label}${input.type === "image" ? "" : ` (${source.id})`}${source.available ? "" : " — unavailable"}`,
    })),
  ];
  if (binding && !matching.some((source) => source.id === binding.sourceId))
    options.push({ value: binding.sourceId, label: binding.sourceId });
  return (
    <div className="binding-field">
      <h3>{input.label}</h3>
      <small>
        {input.description ??
          `Optional ${input.type === "number" ? (input.quantity ?? "numeric") : input.type} input`}
      </small>
      <Select
        label={`${input.label} integration`}
        value={integrationId}
        options={[
          { value: "", label: "Not connected" },
          ...integrations
            .filter((integration) =>
              input.type === "calendar"
                ? integration.type === "home-assistant" ||
                  integration.type === "ical"
                : input.type === "image"
                  ? integration.type === "mounted-folder" ||
                    integration.type === "immich"
                  : integration.type === "home-assistant",
            )
            .map((integration) => ({
              value: integration.id,
              label: `${integration.name}${integration.enabled ? "" : " — disabled"}`,
            })),
        ]}
        onChange={(value) => {
          setIntegrationId(value);
          setQuery("");
          setLimit(100);
          onChange();
        }}
      />
      {integrationId && (
        <Select
          label={`${input.label} ${input.type === "calendar" ? "calendar" : input.type === "image" ? "photo source" : input.type === "weather" || input.type === "forecast" ? "weather source" : "sensor"}`}
          value={binding?.sourceId ?? ""}
          searchable
          onSearch={(value) => {
            setQuery(value);
            setLimit(100);
          }}
          options={options}
          onChange={(sourceId) =>
            onChange(sourceId ? { integrationId, sourceId } : undefined)
          }
        />
      )}
      {loading && <small role="status">Finding sources…</small>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && integrationId && !matching.length && (
        <small>
          {input.type === "calendar"
            ? "No calendars found. Check calendar access and availability in the integration."
            : input.type === "image"
              ? integrations.find((item) => item.id === integrationId)?.type ===
                "immich"
                ? "No albums found. Check album access in Immich or search by album name."
                : "No photos found. Check the folder mount or search by folder/file name."
              : input.type === "weather" || input.type === "forecast"
                ? `No compatible weather sources found.${input.type === "forecast" ? ` The entity must support ${input.period} forecasts.` : ""} Search by friendly name or entity ID.`
                : "No compatible sensors found. Search by friendly name or entity ID."}
        </small>
      )}
      {total > limit && (
        <small>
          Showing the first {limit} matches. Narrow your search.
          {limit < 500 && (
            <button
              type="button"
              className="text-button"
              onClick={() => setLimit(500)}
            >
              Show more
            </button>
          )}
        </small>
      )}
    </div>
  );
}

function CalendarBindingField({
  input,
  binding,
  integrations,
  onChange,
}: {
  input: FaceInput;
  binding?: CalendarBinding;
  integrations: Integration[];
  onChange: (binding?: Bindings[string]) => void;
}) {
  const [generation, setGeneration] = useState(0);
  const sources = binding?.calendars ?? [];
  const update = (calendars: CalendarBinding["calendars"]) =>
    onChange(calendars.length ? { calendars } : undefined);
  return (
    <section className="calendar-bindings">
      <h3>{input.label}</h3>
      <p className="fine-print">
        Merge up to eight calendars. Busy-only is the default. Enabling titles
        publishes them to anyone who can reach this display URL—even if the face
        hides them. Descriptions, locations, attendees, and links are never
        shared.
      </p>
      {sources.map((source, index) => (
        <div
          className="binding-field"
          key={`${source.integrationId}/${source.sourceId}`}
        >
          <strong>
            {integrations.find((item) => item.id === source.integrationId)
              ?.name ?? "Unavailable integration"}{" "}
            · {source.sourceId}
          </strong>
          <label className="toggle-field">
            <span>Publish event titles</span>
            <input
              type="checkbox"
              checked={source.showTitle}
              onChange={(event) =>
                update(
                  sources.map((item, position) =>
                    position === index
                      ? { ...item, showTitle: event.target.checked }
                      : item,
                  ),
                )
              }
            />
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() =>
              update(sources.filter((_, position) => position !== index))
            }
          >
            Remove calendar
          </button>
        </div>
      ))}
      {sources.length < 8 && (
        <BindingField
          key={generation}
          input={{ ...input, label: "Add calendar" }}
          integrations={integrations}
          onChange={(source) => {
            if (
              !source ||
              sources.some(
                (item) =>
                  item.integrationId === source.integrationId &&
                  item.sourceId === source.sourceId,
              )
            )
              return;
            update([...sources, { ...source, showTitle: false }]);
            setGeneration((value) => value + 1);
          }}
        />
      )}
    </section>
  );
}

export function BindingFields({
  face,
  bindings,
  integrations,
  onChange,
}: {
  face: FaceManifest;
  bindings: Bindings;
  integrations: Integration[];
  onChange: (value: Bindings) => void;
}) {
  if (face.schemaVersion === 1 || !face.inputs.length) return null;
  return (
    <section className="binding-fields">
      <div className="form-divider" />
      <span className="eyebrow">DATA SOURCES</span>
      <p className="fine-print">
        Choose only the data you want to share. Anyone who can access this
        display can read these values.
        {face.inputs.some((input) => input.type === "image") &&
          " Photo sources share the whole selected folder or album, not just the currently visible image."}
      </p>
      {!integrations.length && (
        <p>
          Add a connection on the Integrations page, then return here to choose
          a source.
        </p>
      )}
      {face.inputs.map((input) => {
        const binding = bindings[input.key];
        const update = (binding?: Bindings[string]) => {
          const next = { ...bindings };
          if (binding) next[input.key] = binding;
          else delete next[input.key];
          onChange(next);
        };
        return input.type === "calendar" ? (
          <CalendarBindingField
            key={`${face.id}/${input.key}`}
            input={input}
            integrations={integrations}
            binding={
              binding && isCalendarBinding(binding) ? binding : undefined
            }
            onChange={update}
          />
        ) : (
          <BindingField
            key={`${face.id}/${input.key}`}
            input={input}
            binding={
              binding && !isCalendarBinding(binding) ? binding : undefined
            }
            integrations={integrations}
            onChange={update}
          />
        );
      })}
    </section>
  );
}

export function useDataPreview(
  deviceId: string,
  face: FaceManifest | undefined,
  bindings: Bindings,
  sceneId?: string,
) {
  const key = JSON.stringify([sceneId, face?.id, face?.version, bindings]);
  const [result, setResult] = useState<{
    key: string;
    data?: FaceData;
    error?: string;
  }>();
  useEffect(() => {
    if (!face || face.schemaVersion === 1 || !Object.keys(bindings).length)
      return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const response = await api<{ data: FaceData }>(
          `/api/devices/${deviceId}/preview`,
          {
            method: "POST",
            signal: controller.signal,
            body: JSON.stringify({ faceId: face!.id, bindings, sceneId }),
          },
        );
        if (!controller.signal.aborted) setResult({ key, data: response.data });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({ key, error: errorMessage(error) });
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(
            () => void refresh(),
            face!.schemaVersion >= 4 ? 30000 : 5000,
          );
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [key, deviceId]);
  return result?.key === key ? result : undefined;
}
