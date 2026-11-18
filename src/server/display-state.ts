import { randomUUID } from "node:crypto";
import type { DisplayState } from "../shared/contracts.js";
import type { Store } from "./db.js";
import type { Integrations } from "./integrations/manager.js";

export class DisplayStates {
  private epoch = randomUUID();
  private sequence = 0;
  private snapshots = new Map<
    string,
    { content: string; state: DisplayState }
  >();
  constructor(
    private store: Store,
    private integrations: Integrations,
    private reconcile: () => void = () => {},
  ) {}
  state(id: string): DisplayState | undefined {
    this.reconcile();
    const selection = this.store.selection(id);
    const base = this.store.state(id, selection);
    if (!base) {
      this.snapshots.delete(id);
      return;
    }
    const data = this.integrations.data(
      base.face,
      this.store.sceneBindings(base.sceneId),
      undefined,
      {
        deviceId: id,
        revision: base.revision,
        sceneId: base.sceneId,
        activation: selection!.generation,
      },
      base.timezone,
    );
    const content = JSON.stringify({ ...base, data });
    const previous = this.snapshots.get(id);
    if (previous?.content === content) return previous.state;
    const state = {
      ...base,
      data,
      epoch: this.epoch,
      sequence: ++this.sequence,
    };
    this.snapshots.set(id, { content, state });
    return state;
  }
  forget(id: string) {
    this.snapshots.delete(id);
    this.store.forget(id);
  }
}
