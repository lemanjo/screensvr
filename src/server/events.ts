import type { ServerResponse } from "node:http";
import type { Store } from "./db.js";

export class Events {
  private clients = new Map<string, Set<ServerResponse>>();

  online(id: string) {
    return Boolean(this.clients.get(id)?.size);
  }

  add(id: string, response: ServerResponse, store: Store) {
    const total = [...this.clients.values()].reduce(
      (sum, clients) => sum + clients.size,
      0,
    );
    const clients = this.clients.get(id) ?? new Set<ServerResponse>();
    if (clients.size >= 10 || total >= 100) return false;
    clients.add(response);
    this.clients.set(id, clients);
    store.touch(id);
    const timer = setInterval(() => {
      if (!response.write(": heartbeat\n\n")) response.destroy();
      store.touch(id);
    }, 15000);
    timer.unref();
    response.on("close", () => {
      clearInterval(timer);
      clients.delete(response);
      if (!clients.size && this.clients.get(id) === clients)
        this.clients.delete(id);
    });
    return true;
  }

  publish(id: string, store: Store) {
    const state = store.state(id);
    for (const client of this.clients.get(id) ?? []) {
      if (!client.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`))
        client.destroy();
    }
  }

  disconnect(id: string, removed = true) {
    for (const client of this.clients.get(id) ?? []) {
      if (removed) client.write("event: removed\ndata: {}\n\n");
      client.end();
    }
    this.clients.delete(id);
  }

  close() {
    for (const id of this.clients.keys()) this.disconnect(id, false);
  }
}
