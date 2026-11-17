import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import type { ForecastPeriod } from "../src/shared/weather.js";

export const fakeToken = "fake-home-assistant-token-for-tests-only";
type Entity = {
  state: string;
  attributes: Record<string, unknown>;
  last_updated: string;
};
export class FakeHomeAssistant {
  private server = new WebSocketServer({
    port: 0,
    host: "127.0.0.1",
    path: "/api/websocket",
  });
  private subscriptions = new Map<WebSocket, Map<number, string[]>>();
  private forecastSubscriptions = new Map<
    WebSocket,
    Map<number, { entityId: string; period: ForecastPeriod }>
  >();
  readonly entities = new Map<string, Entity>();
  readonly forecasts = new Map<string, unknown>();
  readonly commands: {
    type: string;
    entity_ids?: string[];
    entity_id?: string;
    forecast_type?: ForecastPeriod;
  }[] = [];
  rejectAuthentication = false;
  rejectSubscriptions = false;
  unfiltered = false;
  rejectForecasts = false;
  silentForecasts = false;
  connections = 0;
  url = "";
  static async start() {
    const fake = new FakeHomeAssistant();
    await once(fake.server, "listening");
    const address = fake.server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture address.");
    fake.url = `http://127.0.0.1:${address.port}`;
    return fake;
  }
  private constructor() {
    this.set("sensor.living_room_temperature", "21.3", {
      friendly_name: "Living room temperature",
      device_class: "temperature",
      unit_of_measurement: "°C",
      private_attribute: "DO NOT EXPOSE THIS ATTRIBUTE",
    });
    this.set("sensor.bedroom_temperature", "19.2", {
      friendly_name: "Bedroom temperature",
      device_class: "temperature",
      unit_of_measurement: "°C",
    });
    this.set("sensor.humidity", "48", {
      friendly_name: "Humidity",
      device_class: "humidity",
      unit_of_measurement: "%",
    });
    this.set("binary_sensor.window", "off", { friendly_name: "Window" });
    this.set("sensor.note", "Quiet afternoon", { friendly_name: "Note" });
    this.set("sensor.secret", "DO NOT EXPOSE THIS SENSOR", {
      friendly_name: "Private sensor",
    });
    this.set("weather.home", "rainy", {
      friendly_name: "Home weather",
      temperature: 12.5,
      temperature_unit: "°C",
      supported_features: 3,
      private_attribute: "DO NOT EXPOSE THIS WEATHER ATTRIBUTE",
    });
    for (const period of ["daily", "hourly"] as const)
      this.setForecast(
        "weather.home",
        period,
        Array.from({ length: period === "daily" ? 7 : 24 }, (_, index) => ({
          datetime: new Date(
            Date.now() + index * (period === "daily" ? 86400000 : 3600000),
          ).toISOString(),
          condition: index % 2 ? "cloudy" : "rainy",
          temperature: 14 + index,
          ...(period === "daily" ? { templow: 7 + index } : {}),
          private_attribute: "DO NOT EXPOSE FORECAST METADATA",
        })),
      );
    this.server.on("connection", (socket) => {
      this.connections++;
      const subscriptions = new Map<number, string[]>();
      this.subscriptions.set(socket, subscriptions);
      const forecasts = new Map<
        number,
        { entityId: string; period: ForecastPeriod }
      >();
      this.forecastSubscriptions.set(socket, forecasts);
      socket.on("close", () => {
        this.subscriptions.delete(socket);
        this.forecastSubscriptions.delete(socket);
      });
      socket.send(
        JSON.stringify({ type: "auth_required", ha_version: "2024.1.0" }),
      );
      let authenticated = false;
      socket.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        const result = (value: unknown = null, success = true) =>
          socket.send(
            JSON.stringify({
              id: message.id,
              type: "result",
              success,
              result: value,
            }),
          );
        if (message.type === "auth") {
          authenticated =
            !this.rejectAuthentication && message.access_token === fakeToken;
          socket.send(
            JSON.stringify({
              type: authenticated ? "auth_ok" : "auth_invalid",
              message: "A secret upstream error that must not leak",
            }),
          );
          if (!authenticated) socket.close();
          return;
        }
        if (!authenticated) return socket.close();
        this.commands.push({
          type: message.type,
          ...(message.entity_ids ? { entity_ids: message.entity_ids } : {}),
          ...(message.entity_id ? { entity_id: message.entity_id } : {}),
          ...(message.forecast_type
            ? { forecast_type: message.forecast_type }
            : {}),
        });
        if (message.type === "ping")
          socket.send(JSON.stringify({ id: message.id, type: "pong" }));
        else if (message.type === "get_states")
          result(
            [...this.entities].map(([entity_id, entity]) => ({
              entity_id,
              ...entity,
            })),
          );
        else if (message.type === "subscribe_entities") {
          if (this.rejectSubscriptions) {
            result(null, false);
            return;
          }
          const ids: string[] = message.entity_ids;
          subscriptions.set(message.id, ids);
          result();
          const values = [...this.entities].filter(
            ([id]) => this.unfiltered || ids.includes(id),
          );
          socket.send(
            JSON.stringify({
              id: message.id,
              type: "event",
              event: {
                a: Object.fromEntries(
                  values.map(([id, entity]) => [
                    id,
                    {
                      s: entity.state,
                      a: entity.attributes,
                      lc: Date.parse(entity.last_updated) / 1000,
                    },
                  ]),
                ),
              },
            }),
          );
        } else if (message.type === "weather/subscribe_forecast") {
          if (this.rejectForecasts) {
            result(null, false);
            return;
          }
          forecasts.set(message.id, {
            entityId: message.entity_id,
            period: message.forecast_type,
          });
          result();
          if (!this.silentForecasts)
            socket.send(
              JSON.stringify({
                id: message.id,
                type: "event",
                event: {
                  type: message.forecast_type,
                  forecast:
                    this.forecasts.get(
                      `${message.entity_id}:${message.forecast_type}`,
                    ) ?? null,
                },
              }),
            );
        } else if (message.type === "unsubscribe_events") {
          subscriptions.delete(message.subscription);
          forecasts.delete(message.subscription);
          result();
        } else result(null, false);
      });
    });
  }
  set(id: string, state: string, attributes?: Record<string, unknown>) {
    const entity = {
      state,
      attributes: attributes ?? this.entities.get(id)?.attributes ?? {},
      last_updated: new Date().toISOString(),
    };
    this.entities.set(id, entity);
    this.send(id, {
      c: {
        [id]: {
          "+": {
            s: state,
            a: entity.attributes,
            lu: Date.parse(entity.last_updated) / 1000,
          },
        },
      },
    });
  }
  removeAttribute(id: string, key: string) {
    const entity = this.entities.get(id);
    if (!entity) throw new Error("Unknown fixture entity.");
    delete entity.attributes[key];
    this.send(id, { c: { [id]: { "-": { a: [key] } } } });
  }
  setForecast(entityId: string, period: ForecastPeriod, forecast: unknown) {
    this.forecasts.set(`${entityId}:${period}`, forecast);
    for (const [socket, subscriptions] of this.forecastSubscriptions)
      for (const [id, selected] of subscriptions)
        if (
          selected.entityId === entityId &&
          selected.period === period &&
          socket.readyState === WebSocket.OPEN
        )
          socket.send(
            JSON.stringify({
              id,
              type: "event",
              event: { type: period, forecast },
            }),
          );
  }
  get activeForecasts() {
    return [...this.forecastSubscriptions.values()].reduce(
      (count, subscriptions) => count + subscriptions.size,
      0,
    );
  }
  remove(id: string) {
    this.entities.delete(id);
    this.send(id, { r: [id] });
  }
  private send(id: string, event: unknown) {
    for (const [socket, subscriptions] of this.subscriptions)
      for (const [subscription, ids] of subscriptions)
        if (socket.readyState === WebSocket.OPEN && ids.includes(id))
          socket.send(
            JSON.stringify({ id: subscription, type: "event", event }),
          );
  }
  disconnect() {
    for (const socket of this.server.clients) socket.terminate();
  }
  async close() {
    this.disconnect();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
