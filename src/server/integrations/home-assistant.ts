import WebSocket from "ws";
import type { Datum, Source } from "../../shared/face-data.js";
import { normalize, type EntityState } from "./normalize.js";
import { secureLookup, websocketUrl } from "./network.js";

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly authentication = false,
  ) {
    super(message);
  }
}
export type Reading = { source: Source; reading: Datum };
export type Watch = { ready: Promise<void>; close: () => void };
export interface Connector {
  discover(): Promise<Source[]>;
  watch(ids: string[], callback: (values: Map<string, Reading>) => void): Watch;
  confirm(): Promise<void>;
  close(): void;
}
export type ConnectorFactory = (
  url: string,
  token: string,
  disconnected: (error: ConnectorError) => void,
  signal?: AbortSignal,
) => Promise<Connector>;
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const metadata = (value: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key, item]) =>
          ["device_class", "unit_of_measurement", "friendly_name"].includes(
            key,
          ) && typeof item === "string",
      )
      .map(([key, item]) => [
        key,
        (item as string).slice(0, key === "unit_of_measurement" ? 32 : 80),
      ]),
  );

export class HomeAssistant implements Connector {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private subscriptions = new Map<number, (event: unknown) => void>();
  private cancellations = new Set<() => void>();
  private closed = false;
  private authenticated = false;
  private socket: WebSocket;
  private ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private authenticationTimer: ReturnType<typeof setTimeout>;

  static async connect(
    url: string,
    token: string,
    disconnected: (error: ConnectorError) => void,
    signal?: AbortSignal,
  ) {
    const client = new HomeAssistant(url, token, disconnected);
    const abort = () => client.close();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      await client.ready;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
    return client;
  }
  private constructor(
    url: string,
    token: string,
    private disconnected: (error: ConnectorError) => void,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const options = {
      followRedirects: false,
      rejectUnauthorized: true,
      maxPayload: 16 * 1024 * 1024,
      handshakeTimeout: 10000,
      lookup: secureLookup,
    };
    this.socket = new WebSocket(websocketUrl(url), options);
    this.authenticationTimer = setTimeout(
      () =>
        this.fail(
          new ConnectorError("Home Assistant authentication timed out."),
        ),
      10000,
    );
    this.socket.on("message", (bytes) => {
      try {
        const message: unknown = JSON.parse(bytes.toString());
        if (!object(message) || typeof message.type !== "string")
          throw new Error();
        if (!this.authenticated) {
          if (message.type === "auth_required")
            this.socket.send(
              JSON.stringify({ type: "auth", access_token: token }),
            );
          else if (message.type === "auth_ok") {
            this.authenticated = true;
            clearTimeout(this.authenticationTimer);
            this.readyResolve();
          } else if (message.type === "auth_invalid")
            this.fail(
              new ConnectorError(
                "Home Assistant rejected the access token.",
                true,
              ),
            );
          else throw new Error();
          return;
        }
        if (typeof message.id !== "number") throw new Error();
        if (message.type === "event")
          this.subscriptions.get(message.id)?.(message.event);
        else if (message.type === "result" || message.type === "pong") {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.type === "pong" || message.success === true)
            pending.resolve(message.result);
          else
            pending.reject(
              new ConnectorError(
                "Home Assistant refused a required read command. Check permissions and filtered subscription support.",
              ),
            );
        }
      } catch {
        this.fail(
          new ConnectorError(
            "Home Assistant sent an invalid or oversized state response.",
          ),
        );
      }
    });
    this.socket.on("error", () =>
      this.fail(
        new ConnectorError(
          "Cannot connect to Home Assistant. Check its URL, network, and TLS certificate.",
        ),
      ),
    );
    this.socket.on("close", () =>
      this.fail(new ConnectorError("Home Assistant disconnected.")),
    );
  }

  private fail(error: ConnectorError) {
    if (this.closed) return;
    this.readyReject(error);
    this.close();
    this.disconnected(error);
  }
  private command(
    type: string,
    body: Record<string, unknown> = {},
    id = this.nextId++,
  ) {
    if (this.closed || !this.authenticated)
      return Promise.reject(
        new ConnectorError("Home Assistant is not connected."),
      );
    if (this.pending.size >= 32)
      return Promise.reject(
        new ConnectorError("Too many pending Home Assistant requests."),
      );
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ConnectorError("Home Assistant read timed out."));
      }, 10000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, type, ...body }));
    });
  }
  async discover() {
    const result = await this.command("get_states");
    if (!Array.isArray(result) || result.length > 10000)
      throw new ConnectorError(
        "Home Assistant discovery exceeds the 10,000 entity limit or is invalid.",
      );
    const sources: Source[] = [];
    for (const entity of result) {
      if (
        !object(entity) ||
        typeof entity.entity_id !== "string" ||
        typeof entity.state !== "string" ||
        !object(entity.attributes)
      )
        continue;
      const updated =
        typeof entity.last_updated === "string"
          ? Date.parse(entity.last_updated)
          : NaN;
      const normalized = normalize(entity.entity_id, {
        state: entity.state,
        attributes: entity.attributes,
        updated: Number.isFinite(updated) ? updated : null,
      });
      if (normalized) sources.push(normalized.source);
    }
    return sources;
  }
  watch(
    ids: string[],
    callback: (values: Map<string, Reading>) => void,
  ): Watch {
    if (
      !ids.length ||
      ids.length > 256 ||
      ids.some((id) => !/^(sensor|binary_sensor)\.[a-z0-9_]{1,200}$/.test(id))
    )
      throw new ConnectorError(
        "A filtered subscription requires 1–256 valid sensor IDs.",
      );
    const selected = new Set(ids);
    const states = new Map<string, EntityState>();
    const readings = new Map<string, Reading>();
    const id = this.nextId++;
    let active = true;
    let initial = false;
    let resolveInitial!: () => void;
    let rejectInitial!: (error: Error) => void;
    const initialResult = new Promise<void>((resolve, reject) => {
      resolveInitial = resolve;
      rejectInitial = reject;
    });
    const timer = setTimeout(
      () =>
        rejectInitial(
          new ConnectorError(
            "Home Assistant did not send a filtered initial snapshot.",
          ),
        ),
      10000,
    );
    const close = () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      this.subscriptions.delete(id);
      this.cancellations.delete(close);
      rejectInitial(
        new ConnectorError("Home Assistant subscription was cancelled."),
      );
      if (!this.closed)
        void this.command("unsubscribe_events", { subscription: id }).catch(
          () => {},
        );
    };
    this.cancellations.add(close);
    this.subscriptions.set(id, (event) => {
      if (!active || !object(event)) throw new Error();
      if (
        (!initial && !object(event.a)) ||
        (event.a !== undefined && !object(event.a)) ||
        (event.c !== undefined && !object(event.c)) ||
        (event.r !== undefined &&
          (!Array.isArray(event.r) ||
            event.r.some(
              (key) => typeof key !== "string" || !selected.has(key),
            )))
      )
        throw new Error();
      // An unfiltered server response must never become an accepted snapshot.
      for (const section of ["a", "c"] as const)
        if (
          object(event[section]) &&
          Object.keys(event[section]).some((key) => !selected.has(key))
        )
          throw new Error();
      if (object(event.a)) {
        for (const [key, value] of Object.entries(event.a)) {
          if (!object(value) || typeof value.s !== "string" || !object(value.a))
            throw new Error();
          states.set(key, {
            state: value.s.length <= 200 ? value.s : "unavailable",
            attributes: metadata(value.a),
            updated: this.timestamp(value.lu ?? value.lc),
          });
        }
      }
      if (object(event.c)) {
        for (const [key, delta] of Object.entries(event.c)) {
          const state = states.get(key);
          if (!state || !object(delta)) throw new Error();
          const plus = delta["+"];
          if (object(plus)) {
            if (typeof plus.s === "string")
              state.state = plus.s.length <= 200 ? plus.s : "unavailable";
            if (object(plus.a))
              Object.assign(state.attributes, metadata(plus.a));
            if (plus.lu !== undefined || plus.lc !== undefined)
              state.updated = this.timestamp(plus.lu ?? plus.lc);
          }
          const minus = delta["-"];
          if (object(minus) && Array.isArray(minus.a))
            for (const attribute of minus.a)
              if (typeof attribute === "string")
                delete state.attributes[attribute];
        }
      }
      if (Array.isArray(event.r))
        for (const key of event.r)
          if (typeof key === "string") states.delete(key);
      const previous = new Map(readings);
      readings.clear();
      for (const [key, state] of states) {
        const normalized = normalize(key, state, previous.get(key)?.source);
        if (normalized) readings.set(key, normalized);
      }
      callback(new Map(readings));
      if (!initial) {
        initial = true;
        clearTimeout(timer);
        resolveInitial();
      }
    });
    const ready = Promise.all([
      initialResult,
      this.command("subscribe_entities", { entity_ids: ids }, id),
    ]).then(() => {});
    // Consumers always receive the rejection through ready; close may happen
    // before they begin awaiting it.
    void ready.catch(() => {});
    return { ready, close };
  }
  private timestamp(value: unknown) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.round(value * 1000)
      : null;
  }
  async confirm() {
    await this.command("ping");
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.authenticationTimer);
    this.readyReject(
      new ConnectorError("Home Assistant connection was closed."),
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new ConnectorError("Home Assistant disconnected."));
    }
    this.pending.clear();
    for (const cancel of this.cancellations) cancel();
    this.subscriptions.clear();
    this.socket.terminate();
  }
}
