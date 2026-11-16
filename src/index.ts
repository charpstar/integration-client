// CharpstAR integration client: reference implementation. See README.md.
//
//   node src/index.ts check                       is my key working? (GET /api/v1/me)
//   node src/index.ts push [--dry-run]            send the catalogue (only changed products)
//   node src/index.ts pull <article>... [--dry-run]   download links + images into out/<article>/
//   node src/index.ts listen                      webhook receiver (asset.approved, asset.images.updated, ...)
//   node src/index.ts poll [--once] [--dry-run]   push + download changes every POLL_MINUTES (no webhooks needed)
//   node src/index.ts orders [orderId]            your orders; with an id, that order and the status of each item
//   node src/index.ts render <article>... [--preset <name>] [--dry-run]
//                                                 packshot jobs: start, wait, save into out/<article>/
//   node src/index.ts smoke [catalogue]           me -> push -> GET each article -> one since poll; JSON summary
//
// Node >= 22.18 runs this TypeScript directly; no npm dependencies.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogueDir, loadCatalogue } from "./catalogue.ts";
import { IntegrationClient } from "./client.ts";
import { loadConfig } from "./config.ts";
import { realSleep } from "./http.ts";
import { createLogger, errMsg } from "./log.ts";
import { MissingScopeError, PlatformClient } from "./platform.ts";
import { runSmoke } from "./smoke.ts";
import { loadState } from "./state.ts";
import { startWebhookServer } from "./webhook.ts";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Take `--name value` or `--name=value` out of argv, so the value is not read as an article.
 * Undefined when the option is absent, "" when it has no value.
 */
function takeOption(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a.startsWith(`${name}=`));
  if (i === -1) return undefined;
  if (argv[i] !== name) return argv.splice(i, 1)[0].slice(name.length + 1);
  const hasValue = i + 1 < argv.length && !argv[i + 1].startsWith("--");
  return argv.splice(i, hasValue ? 2 : 1)[1] ?? "";
}

async function main(argv: string[]): Promise<number> {
  argv = [...argv];
  const preset = takeOption(argv, "--preset");
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const [command = "help", ...args] = argv.filter((a) => !a.startsWith("--"));
  const dryRun = flags.has("--dry-run");
  const once = flags.has("--once");
  // smoke prints its JSON summary on stdout, so its log lines go to stderr.
  const log = command === "smoke" ? createLogger((line) => process.stderr.write(line + "\n")) : createLogger();

  if (existsSync(join(DIR, ".env"))) process.loadEnvFile(join(DIR, ".env"));
  const cfg = loadConfig(process.env, DIR);
  const needsKey = !(dryRun && (command === "push" || command === "render"));
  if (command !== "help" && needsKey && !cfg.apiKey) {
    log("error", "config.missing", { missing: ["CHARPSTAR_API_KEY"], hint: "cp .env.example .env and paste your key" });
    return 2;
  }

  const fetchFn = (u: string, i?: RequestInit) => fetch(u, i);
  const platform = new PlatformClient({ base: cfg.apiBase, apiKey: cfg.apiKey }, { fetch: fetchFn, sleep: realSleep, log });
  const state = loadState(cfg.stateFile);
  const client = new IntegrationClient({
    platform,
    state,
    stateFile: cfg.stateFile,
    outDir: cfg.outDir,
    log,
    dryRun,
    download: { fetch: fetchFn, sleep: realSleep, log, dryRun },
    renderWaitMs: cfg.renderWaitMs,
  });

  const push = async () => {
    if (!existsSync(cfg.catalogue)) {
      log("warn", "push.no_catalogue", { catalogue: cfg.catalogue });
      return null;
    }
    return client.push(loadCatalogue(cfg.catalogue), catalogueDir(cfg.catalogue));
  };

  switch (command) {
    case "check": {
      const me = await platform.me();
      log("info", "check.ok", { api: cfg.apiBase, client: me.client, keyPrefix: me.keyPrefix, scopes: me.scopes });
      return 0;
    }
    case "smoke": {
      // Catalogue: the argument, else CATALOGUE (catalogue.json), else the bundled example.
      const file = args[0] ?? (existsSync(cfg.catalogue) ? cfg.catalogue : join(DIR, "catalogue.example.json"));
      const summary = await runSmoke(platform, loadCatalogue(file), cfg.apiBase);
      process.stdout.write(JSON.stringify({ catalogue: file, ...summary }, null, 2) + "\n");
      return summary.ok ? 0 : 1;
    }
    case "push": {
      const s = await push();
      return s && (s.refused.length || s.invalid.length) ? 1 : 0;
    }
    case "pull": {
      if (!args.length) {
        log("error", "pull.usage", { hint: "node src/index.ts pull <article> [<article>...]" });
        return 2;
      }
      await client.pull(args);
      return 0;
    }
    case "listen": {
      if (!cfg.webhookSecret) {
        log("error", "config.missing", { missing: ["WEBHOOK_SECRET"], hint: "the secret shown once when the webhook was created" });
        return 2;
      }
      await startWebhookServer(
        { port: cfg.webhookPort, host: cfg.webhookHost, path: cfg.webhookPath, secret: cfg.webhookSecret, log },
        { isDuplicate: client.isDuplicate, markDelivered: client.markDelivered, onAssetEvent: client.onAssetEvent, onJobSucceeded: client.onJobSucceeded },
      );
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
      return 0;
    }
    case "poll": {
      let stop = false;
      process.once("SIGINT", () => (stop = true));
      process.once("SIGTERM", () => (stop = true));
      do {
        try {
          await push();
          await client.pollOnce();
        } catch (err) {
          if (err instanceof MissingScopeError) throw err; // the next cycle would fail the same way
          log("error", "poll.cycle_failed", { error: errMsg(err) });
          if (once) return 1;
        }
        if (once) break;
        const until = Date.now() + cfg.pollMs;
        while (!stop && Date.now() < until) await realSleep(Math.min(1000, until - Date.now()));
      } while (!stop);
      return 0;
    }
    case "orders": {
      if (!args[0]) {
        await client.listOrders();
        return 0;
      }
      return (await client.showOrder(args[0])) ? 0 : 1;
    }
    case "render": {
      if (!args.length || preset === "") {
        log("error", "render.usage", { hint: "node src/index.ts render <article> [<article>...] [--preset <name>] [--dry-run]" });
        return 2;
      }
      const summary = await client.render(args, { preset });
      return dryRun || summary.ok ? 0 : 1;
    }
    default:
      process.stdout.write(
        [
          "usage: node src/index.ts <command> [--dry-run] [--once]",
          "  check                    is my key working?",
          "  push                     send the catalogue (only what changed)",
          "  pull <article>...        download links + images into out/<article>/",
          "  listen                   receive webhooks (asset.approved, asset.images.updated, job.succeeded, ...)",
          "  poll                     push + download changes every POLL_MINUTES (no webhooks needed)",
          "  orders [orderId]         your orders; with an id, that order and the status of each item",
          "  render <article>... [--preset <name>]",
          "                           start a packshot job per article, wait, save the pictures into out/<article>/",
          "  smoke [catalogue]        me, push, read each article, one since poll; prints a JSON summary",
          "",
        ].join("\n"),
      );
      return command === "help" ? 0 : 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    // A key without the scope a command needs ends here too: the message names the scope and the call.
    process.stderr.write(`fatal: ${errMsg(err)}\n`);
    process.exit(1);
  },
);
