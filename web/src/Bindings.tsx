import { useEffect, useState } from "react";
import type { FaceManifest } from "../../src/shared/contracts.js";
import {
  compatible,
  type Bindings,
  type FaceData,
  type FaceInput,
  type Integration,
  type Source,
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
  binding?: Bindings[string];
  integrations: Integration[];
  onChange: (binding?: Bindings[string]) => void;
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
        `/api/integrations/${integrationId}/sources?q=${encodeURIComponent(query)}&limit=${limit}&type=${input.type}${input.type === "number" && input.quantity ? `&quantity=${input.quantity}` : ""}`,
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
  }, [integrationId, query, limit]);
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
              input.type === "image"
                ? integration.type === "mounted-folder"
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
          label={`${input.label} ${input.type === "image" ? "photo source" : "sensor"}`}
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
          {input.type === "image"
            ? "No photos found. Check the folder mount or search by folder/file name."
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
      </p>
      {!integrations.length && (
        <p>
          Add a connection on the Integrations page, then return here to choose
          a source.
        </p>
      )}
      {face.inputs.map((input) => (
        <BindingField
          key={`${face.id}/${input.key}`}
          input={input}
          binding={bindings[input.key]}
          integrations={integrations}
          onChange={(binding) => {
            const next = { ...bindings };
            if (binding) next[input.key] = binding;
            else delete next[input.key];
            onChange(next);
          }}
        />
      ))}
    </section>
  );
}

export function useDataPreview(
  deviceId: string,
  face: FaceManifest | undefined,
  bindings: Bindings,
) {
  const key = JSON.stringify([face?.id, face?.version, bindings]);
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
            body: JSON.stringify({ faceId: face!.id, bindings }),
          },
        );
        if (!controller.signal.aborted) setResult({ key, data: response.data });
      } catch (error) {
        if (!controller.signal.aborted)
          setResult({ key, error: errorMessage(error) });
      } finally {
        if (!controller.signal.aborted)
          timer = setTimeout(() => void refresh(), 5000);
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
