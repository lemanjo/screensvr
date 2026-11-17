import type { Datum, Source } from "../../shared/face-data.js";

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly authentication = false,
  ) {
    super(message);
  }
}
export type Reading = {
  source: Source;
  reading: Datum;
  // Internal ceiling: connection health cannot renew a forecast indefinitely.
  validUntil?: number;
  // A transient forecast failure must not erase a previous connection's value.
  retainPrevious?: boolean;
};
export type Watch = { ready: Promise<void>; close(): void };
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

export type PhotoHandle = {
  key: string;
  load(): Promise<Buffer>;
  close(): Promise<void>;
};
export interface PhotoConnector extends Connector {
  read(sourceId: string, index: number): Promise<PhotoHandle>;
}
export function isPhotoConnector(client?: Connector): client is PhotoConnector {
  return Boolean(
    client && "read" in client && typeof client.read === "function",
  );
}
