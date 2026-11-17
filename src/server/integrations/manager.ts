import type { FaceManifest } from "../../shared/contracts.js";
import {
  bindingsSchema,
  compatible,
  emptyDatum,
  faceDataSchema,
  type Bindings,
  type FaceData,
  type Integration,
  type PhotoValue,
  type Source,
} from "../../shared/face-data.js";
import type { IntegrationRow, Store } from "../db.js";
import { UserError } from "../faces.js";
import { Secrets } from "../integration-key.js";
import { Photos, type PhotoScope } from "../photos.js";
import { MountedFolder } from "./mounted-folder.js";
import {
  ConnectorError,
  HomeAssistant,
  type Connector,
  type ConnectorFactory,
  type Reading,
  type Watch,
} from "./home-assistant.js";

type Runtime = {
  revision: number;
  status: Integration["status"];
  error: string | null;
  client?: Connector;
  abort: AbortController;
  watch?: Watch;
  watchGeneration: number;
  selected: string;
  initialized: boolean;
  readings: Map<string, Reading>;
  retry?: ReturnType<typeof setTimeout>;
  heartbeat?: ReturnType<typeof setInterval>;
  attempts: number;
  confirming: boolean;
  connectionGeneration: number;
  discovery?: { at: number; sources: Source[] };
  discoveryPending?: Promise<Source[]>;
};

export class Integrations {
  readonly secrets: Secrets;
  readonly photos: Photos;
  private runtimes = new Map<string, Runtime>();
  private closed = false;
  private previewCount = 0;
  private operations = new Set<AbortController>();
  constructor(
    private store: Store,
    directory: string,
    private changed: (id: string) => void,
    private connect: ConnectorFactory = HomeAssistant.connect,
    private photosDirectory = "/photos",
  ) {
    this.secrets = new Secrets(
      directory,
      store.integrations().some((row) => Boolean(row.credentials)),
    );
    this.photos = new Photos(store, (id) => {
      const client = this.runtimes.get(id)?.client;
      return client instanceof MountedFolder ? client : undefined;
    });
  }
  private current(id: string, runtime: Runtime) {
    return !this.closed && this.runtimes.get(id) === runtime;
  }
  reconcile() {
    if (this.closed) return;
    const rows = this.store.integrations();
    for (const [id, runtime] of this.runtimes) {
      const row = rows.find((item) => item.id === id);
      if (!row || row.revision !== runtime.revision) {
        this.stop(runtime);
        this.runtimes.delete(id);
      }
    }
    for (const row of rows) {
      let runtime = this.runtimes.get(row.id);
      if (!runtime) {
        runtime = {
          revision: row.revision,
          status: row.enabled ? "connecting" : "disabled",
          error: null,
          abort: new AbortController(),
          watchGeneration: 0,
          selected: "",
          initialized: false,
          readings: new Map(),
          attempts: 0,
          confirming: false,
          connectionGeneration: 0,
        };
        this.runtimes.set(row.id, runtime);
        if (row.enabled) void this.start(row, runtime);
        this.changed(row.id);
      } else if (runtime.client) this.watch(row.id, runtime);
    }
  }
  private async start(row: IntegrationRow, runtime: Runtime) {
    if (!this.current(row.id, runtime)) return;
    const generation = ++runtime.connectionGeneration;
    runtime.status = "connecting";
    runtime.error = null;
    this.changed(row.id);
    let token: string;
    try {
      token =
        row.type === "home-assistant"
          ? this.secrets.decrypt(row.credentials)
          : "";
    } catch (error) {
      runtime.status = "error";
      runtime.error = (error as Error).message;
      this.changed(row.id);
      return;
    }
    try {
      const client =
        row.type === "mounted-folder"
          ? new MountedFolder(this.photosDirectory, row.base_url)
          : await this.connect(
              row.base_url,
              token,
              (error) => {
                if (runtime.connectionGeneration === generation)
                  this.failed(row, runtime, error);
              },
              runtime.abort.signal,
            );
      if (client instanceof MountedFolder) await client.confirm();
      if (
        !this.current(row.id, runtime) ||
        runtime.connectionGeneration !== generation
      ) {
        client.close();
        return;
      }
      runtime.client = client;
      runtime.status = "connected";
      runtime.error = null;
      this.watch(row.id, runtime);
      runtime.heartbeat = setInterval(() => {
        if (runtime.confirming) return;
        runtime.confirming = true;
        void client
          .confirm()
          .then(() => {
            if (!this.current(row.id, runtime) || runtime.client !== client)
              return;
            const now = Date.now();
            for (const { reading } of runtime.readings.values())
              if (reading.status === "ready") {
                reading.observedAt = now;
                reading.expiresAt = now + 90000;
              }
            runtime.attempts = 0;
            this.changed(row.id);
          })
          .catch(() => {
            if (runtime.client === client)
              this.failed(
                row,
                runtime,
                new ConnectorError("Integration health check failed."),
              );
          })
          .finally(() => {
            runtime.confirming = false;
          });
      }, 30000);
      runtime.heartbeat.unref();
      this.changed(row.id);
    } catch (error) {
      if (runtime.connectionGeneration === generation)
        this.failed(
          row,
          runtime,
          error instanceof ConnectorError
            ? error
            : new ConnectorError("Cannot connect to the integration."),
        );
    }
  }
  private failed(row: IntegrationRow, runtime: Runtime, error: ConnectorError) {
    if (
      !this.current(row.id, runtime) ||
      runtime.retry ||
      runtime.status === "authentication-error"
    )
      return;
    runtime.connectionGeneration++;
    runtime.watchGeneration++;
    runtime.watch?.close();
    runtime.watch = undefined;
    runtime.client?.close();
    runtime.client = undefined;
    clearInterval(runtime.heartbeat);
    runtime.heartbeat = undefined;
    runtime.status = error.authentication
      ? "authentication-error"
      : "disconnected";
    runtime.error = error.message;
    this.changed(row.id);
    if (!error.authentication) {
      const delay =
        Math.min(30000, 1000 * 2 ** Math.min(runtime.attempts++, 5)) *
        (0.8 + Math.random() * 0.4);
      runtime.retry = setTimeout(() => {
        runtime.retry = undefined;
        void this.start(row, runtime);
      }, delay);
      runtime.retry.unref();
    }
  }
  private selected(id: string) {
    return (
      this.store.db
        .prepare(
          "SELECT DISTINCT source_id FROM device_input_bindings WHERE integration_id = ? ORDER BY source_id",
        )
        .all(id) as { source_id: string }[]
    ).map((row) => row.source_id);
  }
  private watch(id: string, runtime: Runtime) {
    const ids = this.selected(id);
    const selected = JSON.stringify(ids);
    if (!runtime.client || (runtime.selected === selected && runtime.watch))
      return;
    const generation = ++runtime.watchGeneration;
    const old = runtime.watch;
    runtime.selected = selected;
    runtime.initialized = false;
    // Drop removed sources immediately; never cache a formerly authorized value.
    for (const key of runtime.readings.keys())
      if (!ids.includes(key)) runtime.readings.delete(key);
    if (!ids.length) {
      old?.close();
      runtime.watch = undefined;
      runtime.initialized = true;
      return;
    }
    const watch = runtime.client.watch(ids, (values) => {
      if (!this.current(id, runtime) || generation !== runtime.watchGeneration)
        return;
      runtime.readings = values;
      runtime.initialized = true;
      this.changed(id);
    });
    runtime.watch = watch;
    void watch.ready
      .then(() => {
        old?.close();
      })
      .catch(() => {
        old?.close();
        if (
          this.current(id, runtime) &&
          generation === runtime.watchGeneration
        ) {
          const row = this.store.integration(id);
          if (row)
            this.failed(
              row,
              runtime,
              new ConnectorError(
                "Home Assistant filtered sensor subscription failed. Check permissions and API compatibility.",
              ),
            );
        }
      });
  }
  list(): Integration[] {
    return this.store.integrations().map((row) => {
      const runtime = this.runtimes.get(row.id);
      return {
        id: row.id,
        name: row.name,
        ...(row.type === "home-assistant"
          ? { type: "home-assistant" as const, baseUrl: row.base_url }
          : { type: "mounted-folder" as const, folder: row.base_url }),
        enabled: Boolean(row.enabled),
        revision: row.revision,
        hasCredentials: Boolean(row.credentials),
        status: runtime?.status ?? (row.enabled ? "connecting" : "disabled"),
        error: runtime?.error ?? null,
        usage: this.store.usage(row.id),
      };
    });
  }
  private runtime(id: string) {
    const row = this.store.integration(id);
    if (!row) throw new UserError("Integration not found.", 404);
    if (!row.enabled)
      throw new UserError("Enable this integration before selecting a source.");
    const runtime = this.runtimes.get(id);
    if (!runtime?.client || runtime.status !== "connected")
      throw new UserError(
        runtime?.error ?? "Integration is connecting. Try again shortly.",
        503,
      );
    return runtime;
  }
  async discover(id: string, refresh = false) {
    const runtime = this.runtime(id);
    if (
      !refresh &&
      runtime.discovery &&
      Date.now() - runtime.discovery.at < 30000
    )
      return runtime.discovery.sources;
    if (runtime.discoveryPending) return runtime.discoveryPending;
    const pending = runtime
      .client!.discover()
      .then((sources) => {
        if (!this.current(id, runtime))
          throw new UserError("Integration changed. Try again.", 409);
        // Preserve known capabilities while an entity temporarily has no state.
        const previous = new Map(
          runtime.discovery?.sources.map((source) => [source.id, source]),
        );
        sources = sources.map((source) =>
          !source.available && previous.has(source.id)
            ? {
                ...previous.get(source.id)!,
                label: source.label,
                available: false,
              }
            : source,
        );
        runtime.discovery = { at: Date.now(), sources };
        return sources;
      })
      .catch((error) => {
        if (error instanceof UserError) throw error;
        throw new UserError(
          "Could not read integration sources. Check the connection, permissions, and source limits.",
          502,
        );
      })
      .finally(() => {
        if (runtime.discoveryPending === pending)
          runtime.discoveryPending = undefined;
      });
    runtime.discoveryPending = pending;
    return pending;
  }
  async validate(
    manifest: FaceManifest,
    input: unknown,
    previous: Bindings = {},
    deviceId?: string,
  ) {
    const bindings = bindingsSchema.parse(input);
    const inputs = manifest.schemaVersion !== 1 ? manifest.inputs : [];
    const discovery = new Map<string, Promise<Source[]>>();
    for (const [key, binding] of Object.entries(bindings)) {
      const faceInput = inputs.find((item) => item.key === key);
      if (!faceInput)
        throw new UserError("This face does not declare that data input.");
      if (!this.store.integration(binding.integrationId))
        throw new UserError("Integration not found.", 404);
      const old = previous[key];
      if (
        old?.integrationId === binding.integrationId &&
        old.sourceId === binding.sourceId
      )
        continue;
      if (!discovery.has(binding.integrationId))
        discovery.set(
          binding.integrationId,
          this.discover(binding.integrationId),
        );
      const source = (await discovery.get(binding.integrationId)!).find(
        (item) => item.id === binding.sourceId,
      );
      if (!source || !compatible(faceInput, source))
        throw new UserError(
          `Choose a compatible source for ${faceInput.label}.`,
        );
    }
    this.checkLimits(bindings, deviceId);
    return bindings;
  }
  checkLimits(bindings: Bindings, deviceId?: string) {
    for (const id of new Set(
      Object.values(bindings).map((binding) => binding.integrationId),
    )) {
      const sources = new Set(
        (
          this.store.db
            .prepare(
              "SELECT source_id FROM device_input_bindings WHERE integration_id = ? AND device_id != ?",
            )
            .all(id, deviceId ?? "") as { source_id: string }[]
        ).map((row) => row.source_id),
      );
      for (const binding of Object.values(bindings))
        if (binding.integrationId === id) sources.add(binding.sourceId);
      if (sources.size > 256)
        throw new UserError(
          "An integration supports at most 256 selected sources.",
        );
    }
  }
  data(
    manifest: FaceManifest,
    bindings: Bindings,
    overrides?: Map<string, Map<string, Reading>>,
    scope?: PhotoScope,
  ): FaceData {
    const inputs = manifest.schemaVersion !== 1 ? manifest.inputs : [];
    return faceDataSchema.parse(
      Object.fromEntries(
        inputs.map((input) => {
          const binding = bindings[input.key];
          if (!binding) return [input.key, emptyDatum(input)];
          const runtime = this.runtimes.get(binding.integrationId);
          if (!this.store.integration(binding.integrationId)?.enabled)
            return [input.key, emptyDatum(input, "unavailable")];
          const value = overrides?.has(binding.integrationId)
            ? overrides.get(binding.integrationId)!.get(binding.sourceId)
            : runtime?.readings.get(binding.sourceId);
          if (!value)
            return [
              input.key,
              emptyDatum(
                input,
                overrides?.has(binding.integrationId) ||
                  runtime?.initialized ||
                  runtime?.status === "error" ||
                  runtime?.status === "authentication-error"
                  ? "unavailable"
                  : "loading",
              ),
            ];
          if (!compatible(input, value.source))
            return [input.key, emptyDatum(input, "unavailable")];
          const reading = { ...value.reading };
          if (reading.type === "image" && reading.value && scope)
            reading.value = this.photos.grant(
              reading.value as PhotoValue,
              binding,
              input.key,
              scope,
            );
          if (
            reading.status === "ready" &&
            (runtime?.status !== "connected" ||
              (reading.expiresAt ?? 0) <= Date.now())
          )
            reading.status = "stale";
          return [input.key, reading];
        }),
      ),
    );
  }
  async preview(
    manifest: FaceManifest,
    bindings: Bindings,
    signal?: AbortSignal,
    scope?: PhotoScope,
  ) {
    if (this.previewCount >= 4)
      throw new UserError("Too many previews. Try again shortly.", 429);
    this.previewCount++;
    const overrides = new Map<string, Map<string, Reading>>();
    const watches: Watch[] = [];
    const abort = () => {
      for (const watch of watches) watch.close();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await Promise.all(
        [
          ...new Set(
            Object.values(bindings).map((binding) => binding.integrationId),
          ),
        ].map(async (id) => {
          const runtime = this.runtimes.get(id);
          if (!runtime?.client || runtime.status !== "connected") return;
          const ids = [
            ...new Set(
              Object.values(bindings)
                .filter((binding) => binding.integrationId === id)
                .map((binding) => binding.sourceId),
            ),
          ];
          const watch = runtime.client.watch(ids, (values) =>
            overrides.set(id, values),
          );
          watches.push(watch);
          if (signal?.aborted) watch.close();
          await watch.ready;
          if (!this.current(id, runtime))
            throw new UserError("Integration changed. Try again.", 409);
        }),
      );
      return this.data(manifest, bindings, overrides, scope);
    } catch (error) {
      if (error instanceof UserError) throw error;
      throw new UserError(
        "Could not preview these sources. Check the integration connection.",
        502,
      );
    } finally {
      for (const watch of watches) watch.close();
      signal?.removeEventListener("abort", abort);
      this.previewCount--;
    }
  }
  async test(url: string, token: string) {
    if (this.operations.size >= 4)
      throw new UserError("Too many connection tests. Try again shortly.", 429);
    const abort = new AbortController();
    this.operations.add(abort);
    let client: Connector | undefined;
    try {
      client = await this.connect(url, token, () => {}, abort.signal);
      abort.signal.addEventListener("abort", () => client?.close(), {
        once: true,
      });
      if (abort.signal.aborted) client.close();
      await client.confirm();
      return { ok: true };
    } catch (error) {
      throw new UserError(
        error instanceof ConnectorError
          ? error.message
          : "Could not test the Home Assistant connection.",
        502,
      );
    } finally {
      client?.close();
      this.operations.delete(abort);
    }
  }
  async testFolder(folder: string) {
    if (this.operations.size >= 4)
      throw new UserError("Too many connection tests. Try again shortly.", 429);
    const operation = new AbortController();
    this.operations.add(operation);
    const client = new MountedFolder(this.photosDirectory, folder);
    operation.signal.addEventListener("abort", () => client.close(), {
      once: true,
    });
    try {
      await client.confirm();
      return { ok: true };
    } catch (error) {
      throw new UserError(
        error instanceof ConnectorError
          ? error.message
          : "Cannot read the photo folder.",
        502,
      );
    } finally {
      client.close();
      this.operations.delete(operation);
    }
  }
  retry(id: string) {
    const runtime = this.runtimes.get(id);
    if (
      runtime &&
      runtime.status !== "connected" &&
      runtime.status !== "disabled"
    ) {
      this.stop(runtime);
      this.runtimes.delete(id);
      this.reconcile();
    }
  }
  private stop(runtime: Runtime) {
    runtime.abort.abort();
    clearTimeout(runtime.retry);
    clearInterval(runtime.heartbeat);
    runtime.watch?.close();
    runtime.client?.close();
  }
  close() {
    this.closed = true;
    for (const runtime of this.runtimes.values()) this.stop(runtime);
    for (const operation of this.operations) operation.abort();
    this.runtimes.clear();
    this.photos.close();
  }
}
