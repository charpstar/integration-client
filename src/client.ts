// The integration flow, independent of where products come from:
//   push()        catalogue -> POST /api/v1/products, sending only what changed since the last accepted push
//   pull()        GET /api/v1/assets?articles= -> out/<article>/
//   pollOnce()    GET /api/v1/assets?since=<cursor>, following nextCursor -> out/<article>/
//                 (for when you can't receive webhooks)
//   onAssetEvent  webhook asset.approved / asset.images.updated / status.changed to delivered
//                 -> fresh GET -> out/<article>/
//   listOrders()  GET /api/v1/orders -> one log line per order
//   showOrder()   GET /api/v1/orders/{orderId} -> the order and the status of each item
//   render()      POST /api/v1/jobs (one packshot job per article) -> GET /api/v1/jobs/{jobId} until
//                 each has finished -> out/<article>/<fileName>
//   onJobSucceeded  webhook job.succeeded -> out/<article>/<fileName>
// Everything that touches state runs one at a time.

import { randomUUID } from "node:crypto";
import type { CatalogueRow, ProductPayload } from "./catalogue.ts";
import { toPayload } from "./catalogue.ts";
import type { DownloadDeps } from "./download.ts";
import { saveAsset, saveJobOutputs } from "./download.ts";
import type { Sleep } from "./http.ts";
import { realSleep } from "./http.ts";
import type { Logger } from "./log.ts";
import { errMsg } from "./log.ts";
import type { Asset, Job, Order, PackshotJob, PlatformClient, UpsertResult } from "./platform.ts";
import { JOBS_PER_POST, isAccepted } from "./platform.ts";
import type { State } from "./state.ts";
import { saveState } from "./state.ts";
import type { AssetEventType, WebhookEvent } from "./webhook.ts";

const OVERLAP_MS = 2 * 60_000; // re-ask for the last 2 minutes on every poll
const EPOCH = "1970-01-01T00:00:00.000Z"; // first poll: everything (the API needs a since)
const RENDER_POLL_MS = 10_000; // a waiting render reads its jobs this often
const RENDER_WAIT_MS = 15 * 60_000; // and stops waiting after this long (the jobs themselves go on)

export type ClientDeps = {
  platform: PlatformClient;
  state: State;
  stateFile: string;
  outDir: string;
  log: Logger;
  dryRun: boolean;
  download: DownloadDeps;
  now?: () => number;
  print?: (text: string) => void;
  sleep?: Sleep;
  renderPollMs?: number;
  renderWaitMs?: number;
};

export type RenderSummary = {
  /** True when every article's pictures were saved. */
  ok: boolean;
  total: number;
  /** Jobs the API started. */
  started: number;
  /** Articles whose job succeeded and whose files are in out/<article>/. */
  saved: string[];
  /** Articles without a delivered model yet (409 not_ready). */
  notReady: string[];
  /** Jobs the API did not start for another reason, as "article: code". */
  refused: string[];
  /** Jobs that failed or were cancelled, and files that could not be saved, as "article: reason". */
  failed: string[];
  /** Articles whose job was still queued or running when the wait ran out. */
  waiting: string[];
};

export type PushSummary = {
  total: number;
  skipped_unchanged: number;
  sent: number;
  results: Record<string, number>;
  invalid: string[];
  refused: string[];
  /** Articles the platform accepted in this push (any accepted result). */
  accepted: string[];
};

/** What an order's log line holds: `items` is the total, `counts` the number in each status. */
const orderFields = (o: Order) => ({
  order: o.id,
  status: o.status,
  source: o.source,
  createdAt: o.createdAt,
  items: Object.values(o.counts ?? {}).reduce((sum, n) => sum + n, 0),
  counts: o.counts,
});

export class IntegrationClient {
  private d: ClientDeps;
  private now: () => number;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(deps: ClientDeps) {
    this.d = deps;
    this.now = deps.now ?? Date.now;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private save(): void {
    if (!this.d.dryRun) saveState(this.d.stateFile, this.d.state);
  }

  /** Send every catalogue row whose content changed since the platform last accepted it. */
  push(rows: CatalogueRow[], baseDir: string): Promise<PushSummary> {
    return this.exclusive(async () => {
      const st = this.d.state;
      const s: PushSummary = { total: rows.length, skipped_unchanged: 0, sent: 0, results: {}, invalid: [], refused: [], accepted: [] };
      const toSend: Array<{ payload: ProductPayload; hash: string }> = [];
      for (const row of rows) {
        const m = toPayload(row, baseDir);
        if (!m.ok) {
          s.invalid.push(`${m.article}: ${m.reason}`);
          this.d.log("warn", "push.invalid", { article: m.article, reason: m.reason });
          continue;
        }
        if (m.warnings.length) this.d.log("warn", "push.warnings", { article: m.payload.articleId, warnings: m.warnings });
        if (!this.d.dryRun && st.products[m.payload.articleId]?.hash === m.hash) {
          s.skipped_unchanged++;
          continue;
        }
        toSend.push({ payload: m.payload, hash: m.hash });
      }

      if (this.d.dryRun) {
        const print = this.d.print ?? ((t: string) => process.stdout.write(t + "\n"));
        for (const t of toSend) print(JSON.stringify(t.payload, null, 2));
        this.d.log("info", "push.dry_run", { would_send: toSend.length, articles: toSend.map((t) => t.payload.articleId), invalid: s.invalid.length });
        return s;
      }

      const results: UpsertResult[] = toSend.length ? await this.d.platform.upsertProducts(toSend.map((t) => t.payload)) : [];
      s.sent = toSend.length;
      const at = new Date(this.now()).toISOString();
      toSend.forEach((t, i) => {
        const r = results[i];
        s.results[r.result] = (s.results[r.result] ?? 0) + 1;
        if (isAccepted(r)) {
          st.products[t.payload.articleId] = { hash: t.hash, result: r.result, at };
          s.accepted.push(r.articleId);
        } else s.refused.push(`${r.articleId}: ${r.error?.code ?? r.result}`); // not saved -> sent again next time
        this.d.log(isAccepted(r) ? "info" : "warn", "push.result", {
          article: r.articleId,
          result: r.result,
          status: r.status,
          statusDetail: r.statusDetail,
          order: r.orderId,
          httpStatus: r.httpStatus,
          error: r.error,
          pendingChanges: r.pendingChanges,
          warnings: r.warnings,
        });
      });
      this.save();
      this.d.log(s.refused.length ? "warn" : "info", "push.done", { ...s });
      return s;
    });
  }

  /** Download links + images for the given articles. */
  pull(articles: string[]): Promise<Asset[]> {
    return this.exclusive(async () => {
      const { assets, unknown } = await this.d.platform.getAssets(articles);
      for (const a of unknown) this.d.log("warn", "pull.unknown_article", { article: a });
      for (const a of assets) await saveAsset(a, this.d.outDir, this.d.download);
      return assets;
    });
  }

  /**
   * Polling mode: everything that changed since the last poll (all pages), plus earlier failures.
   * The cursor is the newest of: the server's own clock when the first page was answered, and the
   * newest updatedAt seen. Both come from the platform, never from this machine's clock.
   */
  pollOnce(): Promise<{ since: string; changed: number; pages: number; saved: number; failed: string[]; articles: string[] }> {
    return this.exclusive(async () => {
      const st = this.d.state;
      const since = st.assetsCursor ? new Date(Date.parse(st.assetsCursor) - OVERLAP_MS).toISOString() : EPOCH;
      const page = await this.d.platform.listAssetsSince(since);
      const changed = page.assets;
      const retry = st.pendingDownloads.filter((a) => !changed.some((c) => c.articleId === a));
      const all = [...changed, ...(retry.length ? (await this.d.platform.getAssets(retry)).assets : [])];
      const failed: string[] = [];
      let saved = 0;
      let cursor = st.assetsCursor;
      const later = (t: string | null | undefined) => {
        if (t && !Number.isNaN(Date.parse(t)) && (!cursor || Date.parse(t) > Date.parse(cursor))) cursor = t;
      };
      later(page.serverTime);
      for (const a of all) {
        later(a.updatedAt);
        try {
          const r = await saveAsset(a, this.d.outDir, this.d.download);
          if (r.failed.length) failed.push(a.articleId);
          else saved++;
        } catch (err) {
          failed.push(a.articleId);
          this.d.log("error", "poll.save_failed", { article: a.articleId, error: errMsg(err) });
        }
      }
      if (!this.d.dryRun) {
        st.assetsCursor = cursor;
        st.pendingDownloads = failed;
        this.save();
      }
      this.d.log(failed.length ? "warn" : "info", "poll.done", { since, pages: page.pages, changed: changed.length, retried: retry.length, saved, failed });
      return { since, changed: changed.length, pages: page.pages, saved, failed, articles: changed.map((a) => a.articleId) };
    });
  }

  /** Webhook handler: fetch the article fresh (events can arrive late or out of order) and save it. */
  onAssetEvent = (article: string, type: AssetEventType, event: WebhookEvent): Promise<unknown> =>
    this.exclusive(async () => {
      // asset.approved carries the asset object itself: a fallback if the fresh GET finds nothing.
      const fallback = type === "asset.approved" ? (event.data as Asset | null | undefined) : null;
      const asset = (await this.d.platform.getAsset(article)) ?? fallback;
      if (!asset?.articleId) throw new Error(`no asset data for ${article}`);
      const r = await saveAsset(asset, this.d.outDir, this.d.download);
      if (r.failed.length) throw new Error(`downloads failed: ${r.failed.join("; ")}`);
      this.d.log("info", "event.saved", { type, article, downloaded: r.downloaded.length });
      return r;
    });

  /** One log line per order: its status and how many items it holds, in total and in each status. */
  async listOrders(): Promise<Order[]> {
    const orders = await this.d.platform.listOrders();
    for (const o of orders) this.d.log("info", "orders.order", orderFields(o));
    this.d.log("info", "orders.done", { orders: orders.length });
    return orders;
  }

  /** The order, then one log line per item with its status. Null when the account has no such order. */
  async showOrder(orderId: string): Promise<Order | null> {
    const order = await this.d.platform.getOrder(orderId);
    if (!order) {
      this.d.log("error", "order.not_found", { order: orderId });
      return null;
    }
    this.d.log("info", "order.status", orderFields(order));
    for (const i of order.items ?? []) {
      this.d.log("info", "order.item", {
        order: order.id,
        article: i.articleId,
        status: i.status,
        statusDetail: i.statusDetail,
        deliveryDate: i.deliveryDate,
        pendingChanges: i.pendingChanges ?? undefined,
      });
    }
    return order;
  }

  /**
   * Start one packshot job per article, wait until each has finished, and save its files under their
   * `fileName` into out/<article>/. A product without a delivered model answers 409 not_ready: that
   * article is reported and the others carry on.
   */
  async render(articles: string[], opts: { preset?: string } = {}): Promise<RenderSummary> {
    const unique = [...new Set(articles)];
    const jobs: PackshotJob[] = unique.map((articleId) => ({ type: "packshot", articleId, ...(opts.preset ? { options: { preset: opts.preset } } : {}) }));
    const s: RenderSummary = { ok: false, total: jobs.length, started: 0, saved: [], notReady: [], refused: [], failed: [], waiting: [] };

    if (this.d.dryRun) {
      const print = this.d.print ?? ((t: string) => process.stdout.write(t + "\n"));
      for (let i = 0; i < jobs.length; i += JOBS_PER_POST) print(JSON.stringify({ jobs: jobs.slice(i, i + JOBS_PER_POST) }, null, 2));
      this.d.log("info", "render.dry_run", { request: "POST /api/v1/jobs", would_start: jobs.length, articles: unique, preset: opts.preset ?? null });
      return s;
    }

    if (opts.preset) {
      // Check the name first: the answer can then list the presets the account does have.
      const presets = await this.d.platform.listPresets("packshot");
      if (!presets.some((p) => p.name === opts.preset)) {
        this.d.log("error", "render.unknown_preset", { preset: opts.preset, presets: presets.map((p) => p.name) });
        s.refused = unique.map((a) => `${a}: unknown_preset`);
        return s;
      }
    }

    // A new key for every run, so running the command again makes new pictures. The key covers the
    // retries inside this call: a request that is sent twice starts its jobs once.
    const starts = await this.d.platform.createJobs(jobs, randomUUID());
    let pending: Array<{ article: string; job: string }> = [];
    for (const r of starts) {
      if (r.id) {
        pending.push({ article: r.articleId, job: r.id });
        this.d.log("info", "render.started", { article: r.articleId, job: r.id });
      } else if (r.error?.code === "not_ready") {
        s.notReady.push(r.articleId);
        this.d.log("warn", "render.not_ready", { article: r.articleId, message: r.error.message, hint: "packshots are made from the delivered 3D model; run render again once the article is delivered" });
      } else {
        s.refused.push(`${r.articleId}: ${r.error?.code ?? "no_job"}`);
        this.d.log("warn", "render.refused", { article: r.articleId, httpStatus: r.httpStatus, error: r.error });
      }
    }
    s.started = pending.length;

    const sleep = this.d.sleep ?? realSleep;
    const every = this.d.renderPollMs ?? RENDER_POLL_MS;
    const limit = this.d.renderWaitMs ?? RENDER_WAIT_MS;
    let waited = 0;
    while (pending.length && waited < limit) {
      // One read per job in every round. A large batch waits longer between rounds, so the reads
      // stay well inside the API's limit of 120 requests a minute.
      const pause = Math.max(every, pending.length * 1000);
      await sleep(pause);
      waited += pause;
      const still: typeof pending = [];
      for (const p of pending) {
        const job = await this.d.platform.getJob(p.job);
        if (job && (job.status === "queued" || job.status === "running")) still.push(p);
        else await this.finishRender(p, job, s);
      }
      pending = still;
    }
    for (const p of pending) {
      s.waiting.push(p.article);
      this.d.log("warn", "render.still_running", { article: p.article, job: p.job, waited_ms: waited, hint: "the job goes on; its pictures are added to the product, so pull the article later" });
    }

    s.ok = s.saved.length === s.total;
    this.d.log(s.ok ? "info" : "warn", "render.done", { ...s });
    return s;
  }

  private async finishRender(p: { article: string; job: string }, job: Job | null, s: RenderSummary): Promise<void> {
    if (job?.status !== "succeeded") {
      const reason = job ? (job.error?.code ?? job.status) : "job_not_found";
      s.failed.push(`${p.article}: ${reason}`);
      this.d.log("error", `render.${job?.status ?? "failed"}`, { article: p.article, job: p.job, error: job?.error ?? null });
      return;
    }
    try {
      const r = await saveJobOutputs(job, this.d.outDir, this.d.download);
      if (r.failed.length) s.failed.push(`${p.article}: download_failed`);
      else s.saved.push(p.article);
    } catch (err) {
      s.failed.push(`${p.article}: download_failed`);
      this.d.log("error", "render.save_failed", { article: p.article, job: p.job, error: errMsg(err) });
    }
  }

  /**
   * Webhook handler for job.succeeded. The event carries the finished job with its outputs, and a
   * finished job does not change, so the files are saved from the event itself with no extra GET.
   */
  onJobSucceeded = (job: Job): Promise<unknown> =>
    this.exclusive(async () => {
      const r = await saveJobOutputs(job, this.d.outDir, this.d.download);
      if (r.failed.length) throw new Error(`downloads failed: ${r.failed.join("; ")}`);
      this.d.log("info", "event.saved", { type: "job.succeeded", article: job.articleId, job: job.id, downloaded: r.downloaded.length });
      return r;
    });

  isDuplicate = (id: string): boolean => this.d.state.deliveries.includes(id);

  markDelivered = (id: string): void => {
    this.d.state.deliveries.push(id);
    this.save();
  };
}
