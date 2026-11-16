// state.json: what was last accepted per article (so unchanged products are not re-sent), the polling
// cursor, and recent webhook delivery ids. Written atomically (tmp + rename).

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export type State = {
  version: 1;
  products: Record<string, { hash: string; result: string; at: string }>; // last ACCEPTED push per article
  assetsCursor: string | null; // newest server time / updatedAt seen by the poller (never this machine's clock)
  pendingDownloads: string[]; // articles whose download failed; retried on the next poll
  deliveries: string[]; // last 500 webhook delivery ids
};

export const emptyState = (): State => ({ version: 1, products: {}, assetsCursor: null, pendingDownloads: [], deliveries: [] });

export function loadState(file: string): State {
  if (!existsSync(file)) return emptyState();
  return { ...emptyState(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<State>), version: 1 };
}

export function saveState(file: string, state: State): void {
  state.deliveries = state.deliveries.slice(-500);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
