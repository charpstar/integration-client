// Webhook receiver for CharpstAR events. Every event type, with an example, is in the documentation:
// https://charpstar.co/docs
//   POST <your url>   Content-Type: application/json   User-Agent: CharpstAR-Webhooks/1
//   CharpstAR-Event:     the event type, for example asset.approved or job.succeeded
//   CharpstAR-Delivery:  <delivery id>   (the same id on every retry: use it to ignore duplicates)
//   CharpstAR-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(WEBHOOK_SECRET, t + "." + raw body)>
// Verify the signature over the RAW body before parsing it, and refuse a `t` more than 5 minutes off.
// Answer 2xx only when you have handled the event: anything else is retried (1 min, 5 min, 30 min, 2 h,
// 6 h, 12 h; about 21 h in total) and shows up for CharpstAR as a failed delivery.
// Our answers: handled -> 200; bad signature -> 401; handling failed or took > 8 s -> 503 (retry later).
//
// Body (byte-identical on retries): { id, type, occurredAt, client: {id, name}, article, data }
//   product.received      data {articleId, name, category, subcategory, dimensionsCm, productLink, status, receivedAt} -> log
//   status.changed        data {from, to}                -> log; when `to` is "delivered", fetch + save the article
//   review.requested      data {articleId, reviewUrl}    -> log
//   asset.approved        data = the asset object         -> fetch the article fresh + save
//   asset.images.updated  data {added: [ids], removed: [ids]} -> fetch the article fresh + save
//   job.succeeded         data = the job, with outputs    -> save each output under its fileName
//   job.failed            data = the job, with error      -> log
//   job.cancelled         data = the job                  -> log
//   import.completed      data = the import (article is null) -> log its counts
//   ping                  data {message}                 -> 200
// A type this receiver does not know is answered 200 and logged, so a new event type is never retried.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Logger } from "./log.ts";
import { errMsg } from "./log.ts";
import type { Job } from "./platform.ts";

export const SIGNATURE_TOLERANCE_S = 300;
const MAX_BODY = 1024 * 1024;

export function sign(secret: string, body: string, t: number): string {
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

export function verifySignature(
  header: string | undefined,
  body: string,
  secret: string,
  nowS = Math.floor(Date.now() / 1000),
  toleranceS = SIGNATURE_TOLERANCE_S,
): boolean {
  if (!header || !secret) return false;
  let t: number | null = null;
  const v1s: string[] = [];
  for (const part of header.split(",")) {
    const [k, ...rest] = part.trim().split("=");
    const v = rest.join("=");
    if (k === "t" && /^\d+$/.test(v)) t = Number(v);
    else if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) v1s.push(v.toLowerCase());
  }
  if (t === null || v1s.length === 0 || Math.abs(nowS - t) > toleranceS) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(`${t}.${body}`).digest("hex"));
  return v1s.some((v) => {
    const got = Buffer.from(v);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

export type EventType =
  | "product.received"
  | "status.changed"
  | "review.requested"
  | "asset.approved"
  | "asset.images.updated"
  | "job.succeeded"
  | "job.failed"
  | "job.cancelled"
  | "import.completed"
  | "ping";

export type WebhookEvent = {
  id?: string;
  type?: EventType | string;
  occurredAt?: string;
  client?: { id: string; name: string };
  /** The article the event is about (null for ping). */
  article?: string | null;
  data?: Record<string, unknown> | null;
};

/** Events that make us fetch the article and save it. */
export const ASSET_EVENTS = ["asset.approved", "asset.images.updated"] as const;
/** Events we only log (status.changed to "delivered" also fetches). */
export const INFO_EVENTS = ["product.received", "status.changed", "review.requested", "job.failed", "job.cancelled", "import.completed"] as const;
export type AssetEventType = (typeof ASSET_EVENTS)[number] | "status.changed";

type Data = Record<string, unknown>;
/** What the log line of each logged event holds, taken from its `data`. */
const LOG_FIELDS: Record<(typeof INFO_EVENTS)[number], (d: Data) => Data> = {
  "product.received": (d) => ({ status: d.status, name: d.name }),
  "status.changed": (d) => ({ from: d.from, to: d.to }),
  "review.requested": (d) => ({ reviewUrl: d.reviewUrl }),
  "job.failed": (d) => ({ job: d.id, jobType: d.type, status: d.status, error: d.error ?? null }),
  "job.cancelled": (d) => ({ job: d.id, jobType: d.type, status: d.status, error: d.error ?? null }),
  "import.completed": (d) => ({ import: d.id, status: d.status, dryRun: d.dryRun, order: d.orderId, rows: d.rows, processed: d.processed, counts: d.counts, error: d.error ?? null }),
};

/** The job in a job.* event, or null when `data` does not look like one. */
function jobOf(data: Data): Job | null {
  const ok = typeof data.id === "string" && typeof data.articleId === "string" && Array.isArray(data.outputs);
  return ok ? (data as unknown as Job) : null;
}

export type WebhookHandlers = {
  isDuplicate: (deliveryId: string) => boolean;
  markDelivered: (deliveryId: string) => void;
  /** Handle one asset event; resolve = done, reject = failed (we answer 503 so CharpstAR retries). */
  onAssetEvent: (article: string, type: AssetEventType, event: WebhookEvent) => Promise<unknown>;
  /** Save the outputs of a job that succeeded; resolve and reject mean the same as above. */
  onJobSucceeded: (job: Job, event: WebhookEvent) => Promise<unknown>;
};

export type WebhookOptions = {
  port: number;
  host: string;
  path: string;
  secret: string;
  log: Logger;
  timeoutMs?: number; // default 8 s; the sender gives up on a request after 10 s
  now?: () => number;
};

export async function handleWebhook(
  req: { method?: string; url?: string; headers: Record<string, string | string[] | undefined> },
  body: string,
  opts: Pick<WebhookOptions, "path" | "secret" | "log" | "timeoutMs" | "now">,
  h: WebhookHandlers,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const header = (name: string): string | undefined => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== opts.path) return { status: 404, body: { error: "not_found" } };
  const nowS = Math.floor((opts.now ?? Date.now)() / 1000);
  if (!verifySignature(header("charpstar-signature"), body, opts.secret, nowS)) {
    opts.log("warn", "webhook.bad_signature", {});
    return { status: 401, body: { error: "bad_signature" } };
  }
  let event: WebhookEvent;
  try {
    event = JSON.parse(body) as WebhookEvent;
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }
  const delivery = header("charpstar-delivery") || event.id || "";
  const type = header("charpstar-event") || event.type || "";
  if (delivery && h.isDuplicate(delivery)) {
    opts.log("info", "webhook.duplicate", { delivery });
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  if (type === "ping") {
    if (delivery) h.markDelivered(delivery);
    opts.log("info", "webhook.ping", { delivery });
    return { status: 200, body: { ok: true } };
  }
  const article = typeof event.article === "string" && event.article ? event.article : null;
  const data = (event.data ?? {}) as Data;
  const deliveredNow = type === "status.changed" && data.to === "delivered";
  if ((INFO_EVENTS as readonly string[]).includes(type) && !deliveredNow) {
    if (delivery) h.markDelivered(delivery);
    const fields = LOG_FIELDS[type as keyof typeof LOG_FIELDS](data);
    opts.log(type === "job.failed" ? "warn" : "info", `webhook.${type}`, { delivery, article, ...fields });
    return { status: 200, body: { ok: true, article } };
  }

  // What is left either saves files or is a type this receiver does not know.
  let work: () => Promise<unknown>;
  if (type === "job.succeeded") {
    const job = jobOf(data);
    if (!job) return { status: 200, body: { ok: true, ignored: "no_job" } };
    work = () => h.onJobSucceeded(job, event);
  } else if ((ASSET_EVENTS as readonly string[]).includes(type) || deliveredNow) {
    if (!article) return { status: 200, body: { ok: true, ignored: "no_article" } };
    work = () => h.onAssetEvent(article, (deliveredNow ? "status.changed" : type) as AssetEventType, event);
  } else {
    opts.log("info", "webhook.ignored", { delivery, type });
    return { status: 200, body: { ok: true, ignored: type } };
  }

  const timeoutMs = opts.timeoutMs ?? 8000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`write-back took over ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    if (delivery) h.markDelivered(delivery);
    opts.log("info", "webhook.handled", { delivery, type, article });
    return { status: 200, body: { ok: true, article } };
  } catch (err) {
    // Never mark delivered on failure: the platform retries and the retry must run again.
    opts.log("error", "webhook.failed", { delivery, type, article, error: errMsg(err) });
    return { status: 503, body: { error: "handler_failed" } };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function startWebhookServer(opts: WebhookOptions, h: WebhookHandlers): Promise<Server> {
  const server = createServer(async (req, res) => {
    let body = "";
    try {
      body = await readBody(req);
    } catch {
      res.writeHead(413).end();
      return;
    }
    const out = await handleWebhook(req, body, opts, h);
    res.writeHead(out.status, { "Content-Type": "application/json" }).end(JSON.stringify(out.body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      opts.log("info", "webhook.listening", { host: opts.host, port: opts.port, path: opts.path });
      resolve(server);
    });
  });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("too_large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
