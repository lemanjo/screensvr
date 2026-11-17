import type { DisplayState } from "../../src/shared/contracts.js";

export function newerSnapshot(
  current: DisplayState | undefined,
  next: DisplayState,
) {
  return !current ||
    current.epoch !== next.epoch ||
    next.sequence >= current.sequence
    ? next
    : current;
}
