import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IntegrationClient } from "../src/client.ts";
import type { Level } from "../src/log.ts";
import { PlatformClient } from "../src/platform.ts";
import { emptyState } from "../src/state.ts";
import { type MockPlatform, TEST_KEY } from "./mockPlatform.ts";

export const ROOT = join(import.meta.dirname, "..");

export function setup(mock: MockPlatform, opts: { dryRun?: boolean; key?: string; renderWaitMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cs-client-test-"));
  const logs: Array<{ level: Level; msg: string; fields?: Record<string, unknown> }> = [];
  const log = (level: Level, msg: string, fields?: Record<string, unknown>) => void logs.push({ level, msg, fields });
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);
  const fetchFn = (u: string, i?: RequestInit) => fetch(u, i);
  const platform = new PlatformClient({ base: mock.base, apiKey: opts.key ?? TEST_KEY }, { fetch: fetchFn, sleep, log });
  const state = emptyState();
  const printed: string[] = [];
  const stateFile = join(dir, "state.json");
  const outDir = join(dir, "out");
  const client = new IntegrationClient({
    platform,
    state,
    stateFile,
    outDir,
    log,
    dryRun: opts.dryRun ?? false,
    download: { fetch: fetchFn, sleep, log, dryRun: opts.dryRun ?? false },
    print: (t) => void printed.push(t),
    sleep, // a waiting render never really waits in tests; `sleeps` records how long it would have
    renderWaitMs: opts.renderWaitMs,
  });
  return { dir, logs, sleeps, platform, state, stateFile, outDir, client, printed };
}
