// CharpstAR Integration API client (all field names camelCase). The API reference, with every field,
// is at https://charpstar.co/docs/api.
//   GET  /api/v1/me                          any key        {client:{id,name}, keyPrefix, scopes}
//   POST /api/v1/products                    products:write {products:[...]} <= 50; {results:[...+httpStatus]}, 207 when mixed
//   GET  /api/v1/assets/{article}            assets:read    one article; 404 {error:{code:"not_found"}}
//   GET  /api/v1/assets?articles=a,b,c       assets:read    up to 100: {client, assets, unknown, nextCursor:null}
//   GET  /api/v1/assets?since=<ISO>[&cursor] assets:read    changed after the time, 100 a page: follow nextCursor
//   GET  /api/v1/orders[?status=][&cursor]   products:read  {orders, nextCursor}, newest first, without items
//   GET  /api/v1/orders/{orderId}            products:read  one order with its items; 404 not_found
//   GET  /api/v1/presets[?type=]             jobs:read      {presets}: the render presets saved for the account
//   POST /api/v1/jobs                        jobs:write     {jobs:[...]} <= 50; {results:[...+httpStatus]}, 202, 207 when mixed
//   GET  /api/v1/jobs/{jobId}                jobs:read      one job; outputs once it has succeeded; 404 not_found
//   GET  /api/v1/jobs[?articles=&type=&status=&since=][&cursor]  jobs:read  {jobs, nextCursor}
//   POST /api/v1/jobs/{jobId}/cancel         jobs:write     a queued job only; 409 not_cancellable once it has started
// Errors: {error:{code, message, details?}}. 429 carries Retry-After.
// Idempotency: an identical product answers {result:"unchanged"} and writes nothing. Starting jobs is
// made safe to retry with an Idempotency-Key header.

import type { ProductPayload } from "./catalogue.ts";
import type { FetchLike, Sleep } from "./http.ts";
import { HttpError, fetchWithRetry, stripQuery } from "./http.ts";
import type { Logger } from "./log.ts";

export const CHUNK_SIZE = 20; // products per POST (the API takes up to 50)
export const ARTICLES_PER_GET = 100;
export const JOBS_PER_POST = 50; // jobs per POST (the API's limit)
export const MAX_PAGES = 1000; // safety stop when following nextCursor

export type ApiError = { code: string; message: string; details?: Record<string, unknown> };

export type UpsertResultKind = "created" | "updated" | "unchanged" | "change_request" | "exists_delivered" | "refused" | "error";

export type PendingChange = { field: "dimensionsCm" | "source3dUrl" | string; from: unknown; to: unknown; requestedAt: string | null };

export type UpsertResult = {
  articleId: string;
  result: UpsertResultKind;
  status?: string;
  statusDetail?: string;
  /** The order the product landed in: read it with GET /api/v1/orders/{orderId}. */
  orderId?: string;
  pendingChanges?: PendingChange[];
  variantsCreated?: string[];
  warnings?: string[];
  error?: ApiError;
  httpStatus?: number;
};

export type Me = { client: { id: string; name: string }; keyPrefix: string; scopes: string[]; expiresAt?: string | null };

/** One image of an article (packshots, renders, videos). Only `approved` ones are final. */
export type AssetImage = {
  id: string;
  type: "packshot" | "thumbnail" | "scene" | "render" | "overlay" | "variation" | "video" | "edit" | string;
  variant: string | null;
  url: string;
  /** The file name from the account's naming choice. */
  fileName?: string;
  /** The job that made the image, or null. */
  jobId?: string | null;
  /** Videos only: a still frame. */
  posterUrl?: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
  createdAt: string | null;
  approved: boolean;
  primary: boolean;
};

export type Embed = { dataClient: string; dataArticleId: string; snippet: string };

/** GET /api/v1/assets/{article}. The URL fields are null until the 3D is delivered. */
export type Asset = {
  articleId: string;
  name?: string;
  status: string; // received | in_production | in_review | approved | delivered | cancelled
  statusDetail?: string;
  deliveryDate?: string | null;
  updatedAt?: string | null;
  glbUrl?: string | null;
  usdzUrl?: string | null;
  usdzReady?: boolean;
  thumbnailUrl?: string | null;
  viewerUrl?: string | null;
  arUrl?: string | null;
  embed?: Embed | null;
  images?: AssetImage[];
  variations?: Array<{ articleId: string; status: string; thumbnailUrl: string | null; glbUrl: string | null }>;
};

export type AssetList = { client: { id: string; name: string }; assets: Asset[]; unknown: string[]; nextCursor: string | null };

export type OrderItem = {
  articleId: string;
  status: string; // received | in_production | in_review | approved | delivered | cancelled
  statusDetail?: string;
  deliveryDate: string | null;
  pendingChanges: PendingChange[] | null;
};

/** An order: the batch of products that arrived together. `items` comes with GET /api/v1/orders/{orderId} only. */
export type Order = {
  id: string;
  status: string; // worked out from the items: received | in_production | in_review | delivered | cancelled
  source: "api" | "platform" | "import" | string;
  createdAt: string;
  /** How many items are in each status. */
  counts: Record<string, number>;
  items?: OrderItem[];
};

export type JobType = "packshot" | "scene" | "edit" | "video" | "export";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** How a job's files are named, for this job only. `pattern` goes with preset "custom". */
export type Naming = { preset: "standard" | "gs1" | "amazon" | "custom"; pattern?: string };

export type PackshotView = "front" | "back" | "left" | "right" | "top" | "three_quarter_left" | "three_quarter_right" | "table" | { yaw: number; pitch: number };

/** Anything left out takes the preset's value, else the default (a white, square 2048 px PNG of the front). */
export type PackshotOptions = {
  views?: PackshotView[]; // one picture per view
  background?: string; // "transparent" or a hex colour such as "#FFFFFF"
  size?: 1024 | 2048 | 4096; // long edge in pixels
  aspectRatio?: "1:1" | "16:9";
  format?: "png" | "jpg" | "webp";
  shadows?: boolean;
  lighting?: "studio" | "neutral";
  /** The name of a render preset from GET /api/v1/presets. Options sent next to it win. */
  preset?: string;
};

/** One packshot job to start. The API also runs scene, edit, video and export jobs; this client starts packshots. */
export type PackshotJob = {
  type: "packshot";
  articleId: string;
  variant?: string;
  options?: PackshotOptions;
  naming?: Naming;
  /** Up to 20 values of your own, such as an order number. They come back on the job and in its events. */
  metadata?: Record<string, string>;
};

/** One file a job made. Save it under `fileName`. */
export type JobOutput = {
  id: string;
  type: JobType;
  view: string | null;
  format: string | null;
  fileName: string;
  url: string;
  width: number | null;
  height: number | null;
  bytes: number | null;
};

/** GET /api/v1/jobs/{jobId}, and the `data` of the job.* events. */
export type Job = {
  id: string;
  type: JobType;
  articleId: string;
  variant: string | null;
  status: JobStatus;
  /** The options as applied, defaults filled in. */
  options: Record<string, unknown>;
  naming: Naming | null;
  metadata: Record<string, string>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** Empty until the job finishes; a failed job lists the files it did make. */
  outputs: JobOutput[];
  error: ApiError | null;
};

/** One entry of the answer to POST /api/v1/jobs: the job that started (`id`), or why it did not (`error`). */
export type JobStart = { articleId: string; type: string; id?: string; status?: JobStatus; error?: ApiError; httpStatus: number };

export type JobFilter = { articles?: string[]; type?: JobType; status?: JobStatus; since?: string };

/** A render preset: camera, lighting, background, size and format saved for the account. */
export type Preset = {
  id: string;
  name: string;
  type: "packshot" | "scene";
  description: string | null;
  defaults: Record<string, unknown>;
  exampleUrl: string | null;
};

export class PlatformAuthError extends Error {}

/** 403 forbidden with details.reason "missing_scope": the key works, but it lacks the scope this call needs. */
export class MissingScopeError extends PlatformAuthError {
  scope: string;
  constructor(scope: string, call: string) {
    super(`The API key does not have the scope ${scope}, which ${call} needs. Use a key with that scope ("check" lists the scopes of a key).`);
    this.scope = scope;
  }
}

const OK_RESULTS = new Set<UpsertResultKind>(["created", "updated", "unchanged", "change_request", "exists_delivered"]);
export const isAccepted = (r: UpsertResult): boolean => OK_RESULTS.has(r.result);

/** The {error:{code,message,details}} body of a non-2xx answer, or null. */
export function apiError(json: unknown): ApiError | null {
  const e = (json as { error?: unknown } | null)?.error;
  if (e && typeof e === "object" && typeof (e as ApiError).code === "string") return e as ApiError;
  return null;
}

type Deps = { fetch: FetchLike; sleep: Sleep; log: Logger };

export class PlatformClient {
  private base: string;
  private apiKey: string;
  private deps: Deps;
  /** Server clock (Date header) of the last answer: a cursor that does not depend on our clock. */
  lastServerDate: string | null = null;

  constructor(cfg: { base: string; apiKey: string }, deps: Deps) {
    this.base = cfg.base;
    this.apiKey = cfg.apiKey;
    this.deps = deps;
  }

  private async send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const res = await fetchWithRetry(
      this.deps.fetch,
      `${this.base}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          Accept: "application/json",
          "User-Agent": "charpstar-integration-client/1",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      // 429 (rate limit / daily quota) and 5xx are retried, honouring Retry-After.
      { sleep: this.deps.sleep, log: this.deps.log, label: "platform", retryOn: [429, 500, 502, 503, 504] },
    );
    const date = Date.parse(res.headers.get("date") ?? "");
    if (!Number.isNaN(date)) this.lastServerDate = new Date(date).toISOString();
    if (res.status === 401 || res.status === 403) {
      const text = await res.text();
      const e = apiError(safeJson(text));
      // A missing scope gets its own error, so every command can say which scope the key lacks.
      if (res.status === 403 && e?.details?.reason === "missing_scope" && typeof e.details.scope === "string") {
        throw new MissingScopeError(e.details.scope, `${method} ${stripQuery(path)}`);
      }
      const why = e ? `${e.code}${e.details?.reason ? ` (${String(e.details.reason)}${e.details.scope ? ` ${String(e.details.scope)}` : ""})` : ""}: ${e.message}` : text.slice(0, 200);
      throw new PlatformAuthError(`${res.status} ${path}: ${why} (check CHARPSTAR_API_KEY and its scopes)`);
    }
    return res;
  }

  /** "Is my key working": {client:{id,name}, keyPrefix, scopes}. */
  async me(): Promise<Me> {
    const res = await this.send("GET", "/api/v1/me");
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, "/api/v1/me", text, "platform.me");
    return JSON.parse(text) as Me;
  }

  /** Upsert in chunks. Never throws for per-item problems; returns one result per input, in order. */
  async upsertProducts(products: ProductPayload[]): Promise<UpsertResult[]> {
    const out: UpsertResult[] = [];
    for (let i = 0; i < products.length; i += CHUNK_SIZE) out.push(...(await this.upsertChunk(products.slice(i, i + CHUNK_SIZE))));
    return out;
  }

  private async upsertChunk(chunk: ProductPayload[]): Promise<UpsertResult[]> {
    const res = await this.send("POST", "/api/v1/products", { products: chunk });
    const text = await res.text();
    const json = safeJson(text);
    const rows = (json as { results?: unknown } | null)?.results;

    // Per-item answers: 200 all fine, 207 mixed, or 400/409 when every item failed the same way.
    if (Array.isArray(rows)) {
      const byArticle = new Map((rows as UpsertResult[]).map((r) => [r.articleId, r]));
      return chunk.map((p) => {
        const r = byArticle.get(p.articleId);
        if (!r) return { articleId: p.articleId, result: "error", error: { code: "missing_in_response", message: "no result for this article" }, httpStatus: res.status };
        const known = OK_RESULTS.has(r.result) || r.result === "refused";
        return { ...r, articleId: p.articleId, result: known ? r.result : "error", httpStatus: r.httpStatus ?? res.status };
      });
    }
    // The whole request was refused (400 validation_failed, 409, 413 too_large): nothing was written.
    const err = apiError(json);
    if (err && [400, 409, 413, 422].includes(res.status)) {
      return chunk.map((p) => ({ articleId: p.articleId, result: "refused", error: err, httpStatus: res.status }));
    }
    if (!res.ok) throw new HttpError(res.status, "/api/v1/products", text, "platform.products");
    throw new HttpError(res.status, "/api/v1/products", text, "platform.products (no results in answer)");
  }

  async getAsset(article: string): Promise<Asset | null> {
    const path = `/api/v1/assets/${encodeURIComponent(article)}`;
    const res = await this.send("GET", path);
    const text = await res.text();
    if (res.status === 404) return null;
    if (!res.ok) throw new HttpError(res.status, path, text, "platform.asset");
    return JSON.parse(text) as Asset;
  }

  /** Several articles at once (chunks of 100). Unknown articles are listed in `unknown`. */
  async getAssets(articles: string[]): Promise<{ assets: Asset[]; unknown: string[] }> {
    const assets: Asset[] = [];
    const unknown: string[] = [];
    for (let i = 0; i < articles.length; i += ARTICLES_PER_GET) {
      const list = articles.slice(i, i + ARTICLES_PER_GET).map(encodeURIComponent).join(",");
      const page = await this.list(`/api/v1/assets?articles=${list}`);
      assets.push(...page.assets);
      unknown.push(...page.unknown);
    }
    return { assets, unknown };
  }

  /**
   * Articles changed after `since`, oldest change first, following nextCursor until it is null.
   * Returns the assets and the server time of the first page (safe to use as the next `since`).
   */
  async listAssetsSince(since: string): Promise<{ assets: Asset[]; pages: number; serverTime: string | null }> {
    const assets: Asset[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let serverTime: string | null = null;
    do {
      const q = `since=${encodeURIComponent(since)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await this.list(`/api/v1/assets?${q}`);
      if (pages === 0) serverTime = this.lastServerDate;
      pages++;
      assets.push(...page.assets);
      cursor = page.nextCursor;
    } while (cursor && pages < MAX_PAGES);
    return { assets, pages, serverTime };
  }

  /** Your orders, newest first, following nextCursor until it is null. The list has no items; getOrder has. */
  listOrders(status?: string): Promise<Order[]> {
    return this.pages<Order>(`/api/v1/orders${status ? `?status=${encodeURIComponent(status)}` : ""}`, "orders", "platform.orders");
  }

  /** One order with the status of each item. Null when the account has no such order. */
  getOrder(orderId: string): Promise<Order | null> {
    return this.read<Order>(`/api/v1/orders/${encodeURIComponent(orderId)}`, "platform.order", true);
  }

  /** The render presets saved for the account. Name one in a packshot job's options.preset. */
  async listPresets(type?: "packshot" | "scene"): Promise<Preset[]> {
    const page = await this.read<{ presets?: Preset[] }>(`/api/v1/presets${type ? `?type=${type}` : ""}`, "platform.presets");
    return Array.isArray(page?.presets) ? page.presets : [];
  }

  /**
   * Start packshot jobs, up to 50 per request. Returns one entry per job, in order: the id of the job
   * that started, or the error that refused it (409 not_ready for a product without a delivered model).
   * Never throws for per-job problems. The Idempotency-Key makes a repeat safe: the same key with the
   * same body within 24 hours answers the first result again and starts nothing twice.
   */
  async createJobs(jobs: PackshotJob[], idempotencyKey: string): Promise<JobStart[]> {
    const out: JobStart[] = [];
    for (let i = 0; i < jobs.length; i += JOBS_PER_POST) {
      // Every request needs its own key: a key seen before with a different body answers 409 idempotency_conflict.
      const key = i === 0 ? idempotencyKey : `${idempotencyKey}-${i / JOBS_PER_POST + 1}`;
      out.push(...(await this.createJobChunk(jobs.slice(i, i + JOBS_PER_POST), key)));
    }
    return out;
  }

  private async createJobChunk(chunk: PackshotJob[], idempotencyKey: string): Promise<JobStart[]> {
    const res = await this.send("POST", "/api/v1/jobs", { jobs: chunk }, { "Idempotency-Key": idempotencyKey });
    const text = await res.text();
    const json = safeJson(text);
    const rows = (json as { results?: unknown } | null)?.results;

    // A batch answers a results array (202 when every job started, 207 when mixed): one entry per
    // job, in the order sent, each with its own httpStatus. Whatever the status, the entries decide.
    if (Array.isArray(rows) && rows.length === chunk.length) {
      return chunk.map((job, i) => {
        const r = rows[i] as Partial<JobStart>;
        return { articleId: job.articleId, type: job.type, id: r.id, status: r.status, error: r.error, httpStatus: r.httpStatus ?? res.status };
      });
    }
    // The whole request was refused (400 validation_failed, 409 idempotency_conflict, 413 too_large): nothing started.
    const err = apiError(json);
    if (err && [400, 409, 413].includes(res.status)) {
      return chunk.map((job) => ({ articleId: job.articleId, type: job.type, error: err, httpStatus: res.status }));
    }
    throw new HttpError(res.status, "/api/v1/jobs", text, res.ok ? "platform.jobs (no results in answer)" : "platform.jobs");
  }

  /** One job: its status, its outputs once it has succeeded, its error when it failed. Null when unknown. */
  getJob(jobId: string): Promise<Job | null> {
    return this.read<Job>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, "platform.job", true);
  }

  /** Your jobs, newest first, following nextCursor until it is null. */
  listJobs(filter: JobFilter = {}): Promise<Job[]> {
    const q = new URLSearchParams();
    if (filter.articles?.length) q.set("articles", filter.articles.join(","));
    if (filter.type) q.set("type", filter.type);
    if (filter.status) q.set("status", filter.status);
    if (filter.since) q.set("since", filter.since);
    const query = q.toString();
    return this.pages<Job>(`/api/v1/jobs${query ? `?${query}` : ""}`, "jobs", "platform.jobs");
  }

  /**
   * Cancel a job while it is queued. Returns the cancelled job, or the error when the API refuses:
   * 409 not_cancellable once the job has started, 404 not_found for an unknown job.
   */
  async cancelJob(jobId: string): Promise<{ job: Job | null; error: ApiError | null }> {
    const path = `/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`;
    const res = await this.send("POST", path);
    const text = await res.text();
    if (res.ok) return { job: JSON.parse(text) as Job, error: null };
    const err = apiError(safeJson(text));
    if (err && (res.status === 404 || res.status === 409)) return { job: null, error: err };
    throw new HttpError(res.status, path, text, "platform.job.cancel");
  }

  /** GET one JSON answer. With `orNull`, a 404 (one order or job that does not exist) is null. */
  private async read<T>(path: string, label: string, orNull = false): Promise<T | null> {
    const res = await this.send("GET", path);
    const text = await res.text();
    if (res.status === 404 && orNull) return null;
    if (!res.ok) throw new HttpError(res.status, path, text, label);
    return safeJson(text) as T | null;
  }

  /** GET every page of a list held under `key`, following nextCursor until it is null. */
  private async pages<T>(path: string, key: string, label: string): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next: string = cursor ? `${path}${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(cursor)}` : path;
      const page = (await this.read<Record<string, unknown>>(next, label)) ?? {};
      if (Array.isArray(page[key])) out.push(...(page[key] as T[]));
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : null;
      pages++;
    } while (cursor && pages < MAX_PAGES);
    return out;
  }

  private async list(path: string): Promise<AssetList> {
    const res = await this.send("GET", path);
    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, path, text, "platform.assets");
    const obj = (safeJson(text) ?? {}) as Partial<AssetList>;
    return {
      client: obj.client ?? { id: "", name: "" },
      assets: Array.isArray(obj.assets) ? obj.assets : [],
      unknown: Array.isArray(obj.unknown) ? obj.unknown : [],
      nextCursor: typeof obj.nextCursor === "string" && obj.nextCursor ? obj.nextCursor : null,
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}
