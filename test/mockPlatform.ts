// A mock CharpstAR platform on 127.0.0.1 speaking the Integration API as its OpenAPI document describes it:
// Bearer key, camelCase JSON, errors {error:{code,message,details}}, GET /api/v1/me, POST /api/v1/products
// (single or {products:[...]}, per-item results with httpStatus, 201/200/207, 409 conflict_other_client,
// 400 validation_failed, 413 too_large, the platform's own idempotency: same payload -> "unchanged"),
// 429 + Retry-After, GET /api/v1/assets/{article} | ?articles= | ?since=[&cursor=] with nextCursor paging,
// a fixed Date header (the server clock), and image files under /files/. Records every request.
// Orders: GET /api/v1/orders[?status=&limit=&cursor=] and /api/v1/orders/{orderId}.
// Jobs: GET /api/v1/presets, POST /api/v1/jobs (single or {jobs:[...]}, 202/207, 409 not_ready, 404
// not_found, Idempotency-Key replay and 409 idempotency_conflict), GET /api/v1/jobs[/{jobId}] and
// POST /api/v1/jobs/{jobId}/cancel. There is no renderer: a job moves on each time it is read.
// A key that lacks the scope of a call gets 403 forbidden with details {reason: "missing_scope", scope}.

import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Asset, Job, Order, Preset } from "../src/platform.ts";

export const TEST_KEY = "cs_live_TestKey0123456789abcdefghijklmnopqrstuvwxyz0";
export const MOCK_CLIENT = { id: "3d1f0c52-6a7b-4c8d-9e0f-1a2b3c4d5e6f", name: "Demo CharpstAR" };
/** The scopes of the test key, unless a test takes some away. */
export const MOCK_SCOPES = ["products:read", "products:write", "assets:read", "webhooks:manage", "jobs:read", "jobs:write"];
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTICLE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;
const MAX_BODY = 4_000_000;
const JOB_TYPES = ["packshot", "scene", "edit", "video", "export"];
/** The scope family of each path under /api/v1/: GET needs <family>:read, anything else <family>:write. */
const SCOPE_OF: Record<string, string> = { products: "products", orders: "products", assets: "assets", jobs: "jobs", presets: "jobs" };

type Req = { method: string; path: string; body: unknown; headers: Record<string, string | string[] | undefined> };
type Forced = { status: number; headers?: Record<string, string>; body?: unknown; match?: RegExp };
type Item = { http: number; body: Record<string, unknown> };
type Send = (status: number, payload: unknown, headers?: Record<string, string>) => void;

const err = (code: string, message: string, details?: Record<string, unknown>) => ({ error: { code, message, ...(details ? { details } : {}) } });
const encodeOffset = (n: number) => Buffer.from(String(n)).toString("base64url");

export class MockPlatform {
  server!: Server;
  base = "";
  requests: Req[] = [];
  products = new Map<string, string>(); // article -> canonical payload
  taken = new Set<string>(); // articles owned by another client -> 409 conflict_other_client
  assets = new Map<string, Asset>();
  files = new Map<string, Buffer>();
  /** What the key may do. Remove one to get 403 missing_scope on the calls that need it. */
  scopes = [...MOCK_SCOPES];
  /** Orders, newest first, each with its items. */
  orders: Order[] = [];
  presets: Preset[] = [];
  jobs = new Map<string, Job>();
  /** A job ends on this read of it: the reads before answer "running". Infinity: it never ends. */
  jobDoneOnRead = 2;
  /** How the job of an article ends; "succeeded" when the article is not listed. */
  jobEnds = new Map<string, "failed" | "cancelled">();
  /** The server's clock, sent as the Date header. */
  serverDate = "2026-10-01T00:00:00.000Z";
  /** Items per page of a list (the platform uses 100). */
  pageSize = 100;
  private forced: Forced[] = [];
  private jobReads = new Map<string, number>();
  private idempotent = new Map<string, { raw: string; status: number; payload: unknown }>();

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const rawBuf = Buffer.concat(chunks);
        const raw = rawBuf.toString("utf8");
        const url = new URL(req.url ?? "/", "http://x");
        let body: unknown;
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          body = Symbol.for("invalid");
        }
        this.requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, body, headers: req.headers });
        const send = (status: number, payload: unknown, headers: Record<string, string> = {}) =>
          res
            .writeHead(status, { "Content-Type": "application/json", Date: new Date(this.serverDate).toUTCString(), "X-Request-Id": `req_${this.requests.length}`, ...headers })
            .end(payload === undefined ? "" : JSON.stringify(payload));

        const file = url.pathname.match(/^\/files\/(.+)$/);
        if (file) {
          const bytes = this.files.get(file[1]);
          if (!bytes) return send(404, err("not_found", "No such file."));
          return res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) }).end(bytes);
        }
        if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return send(401, err("unauthorized", "Missing or invalid API key."));
        const fi = this.forced.findIndex((f) => !f.match || f.match.test(url.pathname + url.search));
        if (fi !== -1) {
          const f = this.forced.splice(fi, 1)[0];
          return send(f.status, f.body ?? err("internal_error", "forced"), f.headers);
        }

        const route = `${req.method} ${url.pathname}`;
        if (route === "GET /api/v1/me") return send(200, { client: MOCK_CLIENT, keyPrefix: TEST_KEY.slice(0, 12), scopes: this.scopes });
        // Every other call needs a scope: the path after /api/v1/ and the method decide which.
        const scope = SCOPE_OF[url.pathname.split("/")[3] ?? ""];
        const needed = scope ? `${scope}:${req.method === "GET" ? "read" : "write"}` : null;
        if (needed && !this.scopes.includes(needed)) return send(403, err("forbidden", `This key does not have the ${needed} scope.`, { reason: "missing_scope", scope: needed }));

        if (route === "POST /api/v1/products") {
          if (rawBuf.length > MAX_BODY) return send(413, err("too_large", "The body is over 4,000,000 bytes."));
          if (typeof body !== "object" || body === null) return send(400, err("validation_failed", "The body is not valid JSON."));
          return this.upsert(body, send);
        }
        if (route === "GET /api/v1/assets") return this.list(url, send);
        const one = url.pathname.match(/^\/api\/v1\/assets\/([^/]+)$/);
        if (req.method === "GET" && one) {
          const article = decodeURIComponent(one[1]);
          const a = this.assets.get(article);
          return a ? send(200, a) : send(404, err("not_found", "No such article.", { articleId: article }));
        }

        if (route === "GET /api/v1/orders") {
          const status = url.searchParams.get("status");
          const rows = this.orders.filter((o) => !status || o.status === status).map(({ items: _items, ...order }) => order);
          return this.page(url, "orders", rows, send);
        }
        const order = url.pathname.match(/^\/api\/v1\/orders\/([^/]+)$/);
        if (req.method === "GET" && order) {
          const o = this.orders.find((x) => x.id === decodeURIComponent(order[1]));
          return o ? send(200, o) : send(404, err("not_found", "No such order in your account."));
        }

        if (route === "GET /api/v1/presets") {
          const type = url.searchParams.get("type");
          return send(200, { presets: this.presets.filter((p) => !type || p.type === type) });
        }
        if (route === "POST /api/v1/jobs") {
          if (typeof body !== "object" || body === null) return send(400, err("validation_failed", "The body is not valid JSON."));
          return this.createJobs(body, raw, req.headers["idempotency-key"], send);
        }
        if (route === "GET /api/v1/jobs") {
          const q = url.searchParams;
          const articles = q.get("articles")?.split(",");
          const rows = [...this.jobs.values()]
            .reverse() // newest first
            .filter((j) => (!articles || articles.includes(j.articleId)) && (!q.get("type") || j.type === q.get("type")) && (!q.get("status") || j.status === q.get("status")));
          return this.page(url, "jobs", rows, send);
        }
        const job = url.pathname.match(/^\/api\/v1\/jobs\/([^/]+)(\/cancel)?$/);
        if (job) {
          const j = this.jobs.get(decodeURIComponent(job[1]));
          if (!j) return send(404, err("not_found", "No such job in your account."));
          if (req.method === "GET" && !job[2]) return send(200, this.readJob(j));
          if (req.method === "POST" && job[2]) {
            if (j.status === "queued") Object.assign(j, { status: "cancelled", finishedAt: this.serverDate });
            if (j.status === "cancelled") return send(200, j); // cancelling a cancelled job answers it again
            return send(409, err("not_cancellable", `The job is ${j.status}; only a queued job can be cancelled.`, { status: j.status }));
          }
        }
        send(404, err("not_found", "Not found."));
      });
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", () => r()));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  /** Answer the next request (optionally matching a path regex) with this status. */
  force(status: number, body?: unknown, headers?: Record<string, string>, match?: RegExp): void {
    this.forced.push({ status, body, headers, match });
  }

  /** Load fixtures/assets/<article>.json (with {{BASE}} -> this server) and the files it points at. */
  loadAssetFixture(article: string): Asset {
    const text = readFileSync(join(ROOT, "fixtures", "assets", `${article}.json`), "utf8").replaceAll("{{BASE}}", this.base);
    const { _source: _s, ...asset } = JSON.parse(text) as Asset & { _source?: string };
    this.assets.set(article, asset);
    const png = readFileSync(join(ROOT, "example-images", "chair.png"));
    const jpg = readFileSync(join(ROOT, "example-images", "table.jpg"));
    for (const img of asset.images ?? []) this.files.set(img.url.split("/files/")[1], img.url.endsWith(".png") ? png : jpg);
    return asset;
  }

  /** Read fixtures/<name> (with {{BASE}} -> this server), without its _source note. */
  fixture<T extends object>(name: string): T {
    const text = readFileSync(join(ROOT, "fixtures", name), "utf8").replaceAll("{{BASE}}", this.base);
    const { _source: _s, ...value } = JSON.parse(text) as T & { _source?: string };
    return value as unknown as T;
  }

  /** One page of a list under `key`: ?limit= items (default pageSize), nextCursor while there are more. */
  private page(url: URL, key: string, rows: unknown[], send: Send): void {
    const rawCursor = url.searchParams.get("cursor");
    const from = rawCursor ? Number(Buffer.from(rawCursor, "base64url").toString("utf8")) : 0;
    if (!Number.isInteger(from) || from < 0) return send(400, err("validation_failed", "cursor is not one we gave out."));
    const limit = Number(url.searchParams.get("limit") ?? this.pageSize);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return send(400, err("validation_failed", "limit must be a whole number from 1 to 100."));
    send(200, { [key]: rows.slice(from, from + limit), nextCursor: from + limit < rows.length ? encodeOffset(from + limit) : null });
  }

  private startJob(p: Record<string, unknown>): Item {
    const article = p.articleId;
    const ids = { articleId: typeof article === "string" ? article : null, type: typeof p.type === "string" ? p.type : null };
    const issues: Array<{ path: string; message: string }> = [];
    if (typeof article !== "string" || !ARTICLE_RE.test(article)) issues.push({ path: "articleId", message: "invalid article number" });
    if (typeof p.type !== "string" || !JOB_TYPES.includes(p.type)) issues.push({ path: "type", message: `must be one of ${JOB_TYPES.join(", ")}` });
    if (issues.length) return { http: 400, body: { ...ids, ...err("validation_failed", "The job is not valid. See details.issues.", { issues }) } };
    const a = article as string;
    const asset = this.assets.get(a);
    if (!asset) return { http: 404, body: { ...ids, ...err("not_found", `No product ${a} in your account.`) } };
    if (asset.status !== "delivered") return { http: 409, body: { ...ids, ...err("not_ready", `${a} has no delivered model yet; packshots are made from it.`) } };
    const job: Job = {
      id: `5c0e2f9a-7b14-4d3e-a8c1-${String(this.jobs.size + 1).padStart(12, "0")}`,
      type: p.type as Job["type"],
      articleId: a,
      variant: typeof p.variant === "string" ? p.variant : null,
      status: "queued",
      options: (p.options ?? {}) as Job["options"],
      naming: (p.naming ?? null) as Job["naming"],
      metadata: (p.metadata ?? {}) as Job["metadata"],
      createdAt: this.serverDate,
      startedAt: null,
      finishedAt: null,
      outputs: [],
      error: null,
    };
    this.jobs.set(job.id, job);
    return { http: 202, body: job };
  }

  private createJobs(body: object, raw: string, key: string | string[] | undefined, send: Send): void {
    // An Idempotency-Key replays the first answer for the same body and refuses another body.
    const seen = typeof key === "string" ? this.idempotent.get(key) : undefined;
    if (seen) return seen.raw === raw ? send(seen.status, seen.payload) : send(409, err("idempotency_conflict", "This Idempotency-Key was already used with a different body."));
    const answer = (status: number, payload: unknown) => {
      if (typeof key === "string") this.idempotent.set(key, { raw, status, payload: structuredClone(payload) });
      send(status, payload);
    };
    const batch = (body as { jobs?: unknown }).jobs;
    if (batch === undefined) {
      const r = this.startJob(body as Record<string, unknown>);
      return answer(r.http, r.body);
    }
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 50) return answer(400, err("validation_failed", "jobs must hold 1 to 50 jobs."));
    const results = batch.map((p) => this.startJob(p as Record<string, unknown>));
    // 202 when every job started, 207 otherwise. A started job is answered in short: id, type, articleId, status.
    answer(results.every((r) => r.http === 202) ? 202 : 207, {
      results: results.map((r) => {
        const { id, type, articleId, status } = r.body;
        return r.http === 202 ? { id, type, articleId, status, httpStatus: 202 } : { ...r.body, httpStatus: r.http };
      }),
    });
  }

  /** Reading a job moves it on: running, then (on read number jobDoneOnRead) its end state. */
  private readJob(job: Job): Job {
    if (job.status !== "queued" && job.status !== "running") return job;
    const reads = (this.jobReads.get(job.id) ?? 0) + 1;
    this.jobReads.set(job.id, reads);
    job.startedAt ??= this.serverDate;
    if (reads < this.jobDoneOnRead) return Object.assign(job, { status: "running" });
    const end = this.jobEnds.get(job.articleId) ?? "succeeded";
    Object.assign(job, { status: end, finishedAt: this.serverDate });
    if (end === "failed") job.error = { code: "internal_error", message: "The pictures could not be made. Our team has been told; you can start the job again." };
    if (end === "succeeded") {
      // The outputs of the document's own finished job, served from /files/.
      const done = this.fixture<Job>("jobs/packshot.succeeded.json");
      job.outputs = done.outputs;
      const png = readFileSync(join(ROOT, "example-images", "chair.png"));
      for (const o of job.outputs) this.files.set(o.url.split("/files/")[1], png);
    }
    return job;
  }

  calls(method: string, prefix: string): Req[] {
    return this.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
  }

  postedProducts(): Array<Record<string, unknown>> {
    return this.calls("POST", "/api/v1/products").flatMap((r) => {
      const b = r.body as { products?: Array<Record<string, unknown>> };
      return b.products ?? [b as Record<string, unknown>];
    });
  }

  private list(url: URL, send: (s: number, p: unknown, h?: Record<string, string>) => void): void {
    const articles = url.searchParams.get("articles");
    const since = url.searchParams.get("since");
    if (since !== null) {
      if (!since || Number.isNaN(Date.parse(since))) return send(400, err("validation_failed", "since must be an ISO 8601 time."));
      const rawCursor = url.searchParams.get("cursor");
      let cursor: { t: string; a: string } | null = null;
      if (rawCursor) {
        try {
          cursor = JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
        } catch {
          return send(400, err("validation_failed", "cursor is not one we gave out."));
        }
      }
      const ordered = [...this.assets.values()]
        .map((a) => ({ a: a.articleId, t: new Date(a.updatedAt ?? 0).toISOString(), asset: a }))
        .filter((x) => x.t > new Date(since).toISOString())
        .filter((x) => !cursor || x.t > cursor.t || (x.t === cursor.t && x.a > cursor.a))
        .sort((x, y) => (x.t === y.t ? (x.a < y.a ? -1 : 1) : x.t < y.t ? -1 : 1));
      const page = ordered.slice(0, this.pageSize);
      const last = page[page.length - 1];
      const nextCursor = ordered.length > this.pageSize && last ? Buffer.from(JSON.stringify({ t: last.t, a: last.a })).toString("base64url") : null;
      return send(200, { client: MOCK_CLIENT, assets: page.map((x) => x.asset), unknown: [], nextCursor });
    }
    if (!articles) return send(400, err("validation_failed", "Pass ?articles=a,b,c or ?since=<ISO time>."));
    const want = [...new Set(articles.split(",").filter(Boolean))];
    if (want.length > 100) return send(400, err("validation_failed", "At most 100 articles per request.", { reason: "too_many_articles" }));
    return send(200, {
      client: MOCK_CLIENT,
      assets: want.filter((a) => this.assets.has(a)).map((a) => this.assets.get(a)),
      unknown: want.filter((a) => !this.assets.has(a)),
      nextCursor: null,
    });
  }

  private one(p: Record<string, unknown>): Item {
    const article = p.articleId;
    const issues: Array<{ path: string; message: string }> = [];
    if (typeof article !== "string" || !ARTICLE_RE.test(article)) issues.push({ path: "articleId", message: "invalid article number" });
    if (typeof p.name !== "string" || !p.name.trim()) issues.push({ path: "name", message: "required" });
    for (const [i, r] of ((p.referenceImages ?? []) as Array<Record<string, unknown>>).entries())
      if (typeof r?.url !== "string" || !/^https:\/\/\S+$/.test(r.url)) issues.push({ path: `referenceImages.${i}.url`, message: "must be an https URL" });
    if ("article_id" in p || "reference_images" in p) issues.push({ path: "", message: "snake_case fields are not part of the contract" });
    if (issues.length)
      return { http: 400, body: { articleId: typeof article === "string" ? article : null, result: "refused", ...err("validation_failed", "The product is not valid. See details.issues.", { issues }) } };
    const a = article as string;
    if (this.taken.has(a)) return { http: 409, body: { articleId: a, result: "refused", ...err("conflict_other_client", "This article number is already used by another account.") } };
    const key = JSON.stringify(p);
    const prev = this.products.get(a);
    this.products.set(a, key);
    const result = prev === undefined ? "created" : prev === key ? "unchanged" : "updated";
    return { http: result === "created" ? 201 : 200, body: { articleId: a, result, status: "received" } };
  }

  private upsert(body: object, send: (s: number, p: unknown) => void): void {
    const batch = (body as { products?: unknown }).products;
    if (batch === undefined) {
      const r = this.one(body as Record<string, unknown>);
      return send(r.http, r.body);
    }
    if (!Array.isArray(batch) || batch.length < 1 || batch.length > 50) return send(400, err("validation_failed", "products must hold 1 to 50 products."));
    const results = batch.map((p) => this.one(p as Record<string, unknown>));
    const ok = results.filter((r) => r.http < 300).length;
    const codes = new Set(results.filter((r) => r.http >= 300).map((r) => r.http));
    const http = ok === results.length ? 200 : ok === 0 && codes.size === 1 ? [...codes][0] : 207;
    send(http, { results: results.map((r) => ({ ...r.body, httpStatus: r.http })) });
  }
}
