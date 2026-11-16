// Settings come from the environment; `.env` next to package.json is loaded automatically.

import { resolve } from "node:path";

export type Config = {
  apiBase: string;
  apiKey: string;
  webhookSecret: string;
  webhookPort: number;
  webhookHost: string;
  webhookPath: string;
  catalogue: string;
  outDir: string;
  stateFile: string;
  pollMs: number;
  renderWaitMs: number;
};

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env, dir: string): Config {
  const v = (k: string) => (env[k] ?? "").trim();
  const port = Number(v("WEBHOOK_PORT"));
  const minutes = Number(v("POLL_MINUTES"));
  const renderWait = Number(v("RENDER_WAIT_MINUTES"));
  return {
    apiBase: (v("CHARPSTAR_API_BASE") || "https://platform.charpstar.co").replace(/\/+$/, ""),
    apiKey: v("CHARPSTAR_API_KEY"),
    webhookSecret: v("WEBHOOK_SECRET"),
    webhookPort: Number.isInteger(port) && port > 0 ? port : 8787,
    webhookHost: v("WEBHOOK_HOST") || "127.0.0.1",
    webhookPath: v("WEBHOOK_PATH") || "/charpstar",
    catalogue: resolve(dir, v("CATALOGUE") || "catalogue.json"),
    outDir: resolve(dir, v("OUT_DIR") || "out"),
    stateFile: resolve(dir, v("STATE_FILE") || "state.json"),
    pollMs: (Number.isFinite(minutes) && minutes > 0 ? minutes : 5) * 60_000,
    renderWaitMs: (Number.isFinite(renderWait) && renderWait > 0 ? renderWait : 15) * 60_000,
  };
}
