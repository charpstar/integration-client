import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Level } from "../src/log.ts";
import { silentLogger } from "../src/log.ts";
import type { Job } from "../src/platform.ts";
import { handleWebhook, sign, startWebhookServer, verifySignature } from "../src/webhook.ts";
import { ROOT, setup } from "./helpers.ts";
import { MockPlatform } from "./mockPlatform.ts";

const SECRET = "whsec_testsecret0123456789";
const NOW_S = 1_792_000_000;
const fixture = (name: string) => readFileSync(join(ROOT, "fixtures", "events", `${name}.json`), "utf8");

// A copy of the platform's signer, so a change on
// either side that breaks compatibility fails here.
const platformSign = {
  signPayload(secret: string, body: string, t: number = Math.floor(Date.now() / 1000)): string {
    const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return `t=${t},v1=${v1}`;
  },
  verifySignature(secret: string, body: string, header: string | null | undefined, now: number = Math.floor(Date.now() / 1000)): boolean {
    if (!header) return false;
    const parts = Object.fromEntries(
      header.split(",").map((p) => {
        const i = p.indexOf("=");
        return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
      }),
    );
    const t = Number(parts.t);
    if (!Number.isInteger(t) || Math.abs(now - t) > 300 || !/^[0-9a-f]{64}$/.test(parts.v1 || "")) return false;
    const expected = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
    return timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  },
};

describe("CharpstAR-Signature (t=<unix>,v1=<hex HMAC-SHA256(secret, t.body)>)", () => {
  const body = fixture("asset.approved");

  it("round-trips", () => {
    expect(verifySignature(sign(SECRET, body, NOW_S), body, SECRET, NOW_S)).toBe(true);
  });
  it("is compatible with the platform's webhookSign.ts in both directions", () => {
    for (const name of ["asset.approved", "asset.images.updated", "status.changed", "product.received", "review.requested", "job.succeeded", "job.failed", "job.cancelled", "import.completed", "ping"]) {
      const b = fixture(name);
      const fromPlatform = platformSign.signPayload(SECRET, b, NOW_S);
      expect(fromPlatform).toBe(sign(SECRET, b, NOW_S));
      expect(verifySignature(fromPlatform, b, SECRET, NOW_S)).toBe(true);
      expect(platformSign.verifySignature(SECRET, b, sign(SECRET, b, NOW_S), NOW_S)).toBe(true);
    }
    // Same 300 s window on both sides.
    const h = platformSign.signPayload(SECRET, body, NOW_S);
    for (const dt of [-301, -300, 300, 301]) expect(verifySignature(h, body, SECRET, NOW_S + dt)).toBe(platformSign.verifySignature(SECRET, body, h, NOW_S + dt));
  });
  it("rejects a tampered body, a wrong secret, a stale or future t, and garbage", () => {
    const h = sign(SECRET, body, NOW_S);
    expect(verifySignature(h, body + " ", SECRET, NOW_S)).toBe(false);
    expect(verifySignature(h, body, "whsec_other", NOW_S)).toBe(false);
    expect(verifySignature(h, body, SECRET, NOW_S + 301)).toBe(false);
    expect(verifySignature(h, body, SECRET, NOW_S - 301)).toBe(false);
    expect(verifySignature(h, body, SECRET, NOW_S + 299)).toBe(true);
    expect(verifySignature("v1=abc", body, SECRET, NOW_S)).toBe(false);
    expect(verifySignature(undefined, body, SECRET, NOW_S)).toBe(false);
  });
  it("accepts any matching v1 when several are sent (secret rotation)", () => {
    const good = sign(SECRET, body, NOW_S).split(",")[1];
    expect(verifySignature(`t=${NOW_S},v1=${"0".repeat(64)},${good}`, body, SECRET, NOW_S)).toBe(true);
  });
});

describe("receiver answers", () => {
  const opts = { path: "/charpstar", secret: SECRET, log: silentLogger, now: () => NOW_S * 1000, timeoutMs: 50 };
  const req = (b: string, over: Record<string, string> = {}) => {
    const e = JSON.parse(b) as { id: string; type: string };
    return {
      method: "POST",
      url: "/charpstar",
      headers: { "charpstar-signature": sign(SECRET, b, NOW_S), "charpstar-delivery": e.id, "charpstar-event": e.type, ...over },
    };
  };
  const handlers = (fn: (article: string, type: string) => Promise<unknown> = async () => {}) => {
    const delivered: string[] = [];
    const seen: Array<[string, string]> = [];
    const jobs: Job[] = [];
    return {
      delivered,
      seen,
      jobs,
      h: {
        isDuplicate: (id: string) => delivered.includes(id),
        markDelivered: (id: string) => void delivered.push(id),
        onAssetEvent: (article: string, type: string) => {
          seen.push([article, type]);
          return fn(article, type);
        },
        onJobSucceeded: (job: Job) => {
          jobs.push(job);
          return fn(job.articleId, "job.succeeded");
        },
      },
    };
  };
  /** The receiver's options with a log that keeps its lines. */
  const logged = () => {
    const lines: Array<{ level: Level; msg: string; fields?: Record<string, unknown> }> = [];
    return { lines, opts: { ...opts, log: (level: Level, msg: string, fields?: Record<string, unknown>) => void lines.push({ level, msg, fields }) } };
  };

  it("takes the article from event.article, 200 when handled, then 200 duplicate without handling twice", async () => {
    const body = fixture("asset.images.updated");
    const { h, delivered, seen } = handlers();
    expect(await handleWebhook(req(body), body, opts, h)).toMatchObject({ status: 200, body: { article: "EXAMPLE-CHAIR-01" } });
    expect((await handleWebhook(req(body), body, opts, h)).body).toMatchObject({ duplicate: true });
    expect(seen).toEqual([["EXAMPLE-CHAIR-01", "asset.images.updated"]]);
    expect(delivered).toEqual(["7a2d3c0f-2e3d-4a8b-8b4c-6d7e8f9a0b1c"]);
  });
  it("product.received and status.changed (not to delivered) are logged only", async () => {
    const { h, seen, delivered } = handlers();
    const received = fixture("product.received");
    expect((await handleWebhook(req(received), received, opts, h)).status).toBe(200);
    const toReview = JSON.stringify({ ...JSON.parse(fixture("status.changed")), id: "s2", data: { from: "in_production", to: "in_review" } });
    expect((await handleWebhook(req(toReview), toReview, opts, h)).status).toBe(200);
    expect(seen).toEqual([]);
    expect(delivered).toHaveLength(2);
  });
  it("status.changed to delivered fetches the article", async () => {
    const { h, seen } = handlers();
    const body = fixture("status.changed");
    expect((await handleWebhook(req(body), body, opts, h)).status).toBe(200);
    expect(seen).toEqual([["EXAMPLE-CHAIR-01", "status.changed"]]);
  });
  it("503 when handling fails or is too slow; the delivery is not marked, so the retry runs again", async () => {
    const body = fixture("asset.approved");
    const fail = handlers(async () => {
      throw new Error("disk full");
    });
    expect((await handleWebhook(req(body), body, opts, fail.h)).status).toBe(503);
    const slow = handlers(() => new Promise((r) => setTimeout(r, 200)));
    expect((await handleWebhook(req(body), body, opts, slow.h)).status).toBe(503);
    expect(fail.delivered).toEqual([]);
  });
  it("401 bad signature; 200 ping; 200 ignored unknown event; 404 other paths", async () => {
    const body = fixture("asset.approved");
    const { h, seen } = handlers();
    expect((await handleWebhook(req(body, { "charpstar-signature": "t=1,v1=00" }), body, opts, h)).status).toBe(401);
    const ping = fixture("ping");
    expect((await handleWebhook(req(ping), ping, opts, h)).status).toBe(200);
    const other = JSON.stringify({ id: "o1", type: "asset.deleted", article: "A1", data: {} });
    expect((await handleWebhook(req(other), other, opts, h)).body).toMatchObject({ ignored: "asset.deleted" });
    expect((await handleWebhook({ ...req(body), url: "/other" }, body, opts, h)).status).toBe(404);
    expect(seen).toEqual([]);
  });
  it("job.succeeded hands the job with its outputs to the handler; 503 when saving fails", async () => {
    const body = fixture("job.succeeded");
    const ok = handlers();
    expect(await handleWebhook(req(body), body, opts, ok.h)).toMatchObject({ status: 200, body: { article: "EXAMPLE-CHAIR-01" } });
    expect(ok.jobs).toHaveLength(1);
    expect(ok.jobs[0]).toMatchObject({ id: "5c0e2f9a-7b14-4d3e-a8c1-93f6e2b7d045", status: "succeeded" });
    expect(ok.jobs[0].outputs.map((o) => o.fileName)).toEqual(["09521234567806_C1C0.png", "09521234567806_C2C0.png", "09521234567806_C7C0.png"]);
    expect(ok.delivered).toEqual(["2f3e4d5c-6b7a-4c8d-9e0f-1a2b3c4d5e6f"]);
    expect(ok.seen).toEqual([]); // no article fetch

    const fail = handlers(async () => {
      throw new Error("disk full");
    });
    expect((await handleWebhook(req(body), body, opts, fail.h)).status).toBe(503);
    expect(fail.delivered).toEqual([]);
  });
  it("job.succeeded without a job in data is acknowledged and nothing is saved", async () => {
    const { h, jobs } = handlers();
    const body = JSON.stringify({ ...JSON.parse(fixture("job.succeeded")), data: {} });
    expect(await handleWebhook(req(body), body, opts, h)).toMatchObject({ status: 200, body: { ignored: "no_job" } });
    expect(jobs).toEqual([]);
  });
  it("job.failed and job.cancelled log the job and its error; nothing is fetched or saved", async () => {
    const { h, seen, jobs, delivered } = handlers();
    const { lines, opts: o } = logged();
    for (const name of ["job.failed", "job.cancelled"]) expect((await handleWebhook(req(fixture(name)), fixture(name), o, h)).status).toBe(200);
    expect(lines).toEqual([
      {
        level: "warn",
        msg: "webhook.job.failed",
        fields: {
          delivery: "3a4b5c6d-7e8f-4a9b-8c0d-1e2f3a4b5c6d",
          article: "EXAMPLE-CHAIR-01",
          job: "5c0e2f9a-7b14-4d3e-a8c1-93f6e2b7d045",
          jobType: "packshot",
          status: "failed",
          error: { code: "internal_error", message: "The pictures could not be made. Our team has been told; you can start the job again." },
        },
      },
      {
        level: "info",
        msg: "webhook.job.cancelled",
        fields: { delivery: "4b5c6d7e-8f9a-4b0c-9d1e-2f3a4b5c6d7e", article: "EXAMPLE-CHAIR-01", job: "5c0e2f9a-7b14-4d3e-a8c1-93f6e2b7d045", jobType: "packshot", status: "cancelled", error: null },
      },
    ]);
    expect([seen, jobs]).toEqual([[], []]);
    expect(delivered).toHaveLength(2);
  });
  it("import.completed logs the import's counts (the event has no article)", async () => {
    const { h, seen, delivered } = handlers();
    const { lines, opts: o } = logged();
    const body = fixture("import.completed");
    expect(await handleWebhook(req(body), body, o, h)).toMatchObject({ status: 200, body: { article: null } });
    expect(lines).toEqual([
      {
        level: "info",
        msg: "webhook.import.completed",
        fields: {
          delivery: "2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f",
          article: null,
          import: "7a6b5c4d-0000-4000-8000-000000000022",
          status: "completed",
          dryRun: false,
          order: "4d3c2b1a-0000-4000-8000-000000000011",
          rows: 1200,
          processed: 1200,
          counts: { created: 1100, updated: 80, unchanged: 18, change_request: 0, exists_delivered: 0, refused: 2 },
          error: null,
        },
      },
    ]);
    expect(seen).toEqual([]);
    expect(delivered).toHaveLength(1);
  });
  it("review.requested logs the review link", async () => {
    const { h, seen } = handlers();
    const { lines, opts: o } = logged();
    const body = fixture("review.requested");
    expect((await handleWebhook(req(body), body, o, h)).status).toBe(200);
    expect(lines[0]).toMatchObject({ msg: "webhook.review.requested", fields: { article: "EXAMPLE-CHAIR-01", reviewUrl: expect.stringContaining("/client-review/") } });
    expect(seen).toEqual([]);
  });
  it("an event type this receiver does not know is acknowledged and logged, never handled", async () => {
    const { h, seen, jobs } = handlers();
    const { lines, opts: o } = logged();
    const body = JSON.stringify({ id: "n1", type: "job.started", article: "A1", data: { id: "j1", articleId: "A1", outputs: [] } });
    expect(await handleWebhook(req(body), body, o, h)).toMatchObject({ status: 200, body: { ignored: "job.started" } });
    expect(lines).toEqual([{ level: "info", msg: "webhook.ignored", fields: { delivery: "n1", type: "job.started" } }]);
    expect([seen, jobs]).toEqual([[], []]);
  });
});

describe("end to end: signed event -> GET asset -> out/<article>/", () => {
  let mock: MockPlatform;
  let server: Server;
  beforeEach(async () => {
    mock = await new MockPlatform().start();
  });
  afterEach(async () => {
    await new Promise((r) => server?.close(() => r(null)));
    await mock.stop();
  });
  // The handlers `listen` passes to the receiver.
  const handlersOf = ({ client }: ReturnType<typeof setup>) => ({
    isDuplicate: client.isDuplicate,
    markDelivered: client.markDelivered,
    onAssetEvent: client.onAssetEvent,
    onJobSucceeded: client.onJobSucceeded,
  });

  for (const type of ["asset.approved", "asset.images.updated", "status.changed"]) {
    it(`${type} downloads the approved images and links`, async () => {
      const ctx = setup(mock);
      mock.loadAssetFixture("EXAMPLE-CHAIR-01");
      server = await startWebhookServer(
        { port: 0, host: "127.0.0.1", path: "/charpstar", secret: SECRET, log: silentLogger },
        handlersOf(ctx),
      );
      const port = (server.address() as AddressInfo).port;
      const body = fixture(type);
      const event = JSON.parse(body) as { id: string };
      const t = Math.floor(Date.now() / 1000);
      const post = () =>
        fetch(`http://127.0.0.1:${port}/charpstar`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "CharpstAR-Event": type, "CharpstAR-Delivery": event.id, "CharpstAR-Signature": platformSign.signPayload(SECRET, body, t) },
          body,
        });
      expect((await post()).status).toBe(200);
      const dir = join(ctx.outDir, "EXAMPLE-CHAIR-01");
      expect(existsSync(join(dir, "links.json"))).toBe(true);
      expect(existsSync(join(dir, "images", "img_packshot_front.png"))).toBe(true);
      expect(existsSync(join(dir, "primary.png"))).toBe(true);
      expect(ctx.state.deliveries).toEqual([event.id]);

      expect((await post()).status).toBe(200); // retry of the same delivery: no second fetch
      expect(mock.calls("GET", "/api/v1/assets/EXAMPLE-CHAIR-01")).toHaveLength(1);
    });
  }

  it("job.succeeded saves each output under its fileName, straight from the event (no API call)", async () => {
    const ctx = setup(mock);
    server = await startWebhookServer({ port: 0, host: "127.0.0.1", path: "/charpstar", secret: SECRET, log: silentLogger }, handlersOf(ctx));
    const body = fixture("job.succeeded").replaceAll("{{BASE}}", mock.base);
    const event = JSON.parse(body) as { id: string; data: { outputs: Array<{ fileName: string }> } };
    for (const o of event.data.outputs) mock.files.set(o.fileName, readFileSync(join(ROOT, "example-images", "chair.png")));
    const post = () =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/charpstar`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CharpstAR-Event": "job.succeeded", "CharpstAR-Delivery": event.id, "CharpstAR-Signature": platformSign.signPayload(SECRET, body, Math.floor(Date.now() / 1000)) },
        body,
      });
    expect((await post()).status).toBe(200);
    const dir = join(ctx.outDir, "EXAMPLE-CHAIR-01");
    for (const o of event.data.outputs) expect(statSync(join(dir, o.fileName)).size).toBe(73);
    expect(JSON.parse(readFileSync(join(dir, "outputs.json"), "utf8"))).toHaveLength(3);
    expect(ctx.state.deliveries).toEqual([event.id]);

    expect((await post()).status).toBe(200); // retry of the same delivery: nothing is downloaded again
    expect(mock.requests.map((r) => r.path)).toEqual(event.data.outputs.map((o) => `/files/${o.fileName}`));
  });

  it("answers 503 for job.succeeded when a file can't be downloaded, and saves the rest on the retry", async () => {
    const ctx = setup(mock);
    server = await startWebhookServer({ port: 0, host: "127.0.0.1", path: "/charpstar", secret: SECRET, log: silentLogger }, handlersOf(ctx));
    const body = fixture("job.succeeded").replaceAll("{{BASE}}", mock.base);
    const [first, ...rest] = (JSON.parse(body) as { data: { outputs: Array<{ fileName: string }> } }).data.outputs.map((o) => o.fileName);
    const png = readFileSync(join(ROOT, "example-images", "chair.png"));
    for (const f of rest) mock.files.set(f, png); // the first file answers 404
    const post = () =>
      fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/charpstar`, {
        method: "POST",
        headers: { "CharpstAR-Event": "job.succeeded", "CharpstAR-Delivery": "j1", "CharpstAR-Signature": sign(SECRET, body, Math.floor(Date.now() / 1000)) },
        body,
      });
    expect((await post()).status).toBe(503);
    expect(ctx.state.deliveries).toEqual([]);

    mock.files.set(first, png);
    expect((await post()).status).toBe(200);
    expect(mock.calls("GET", `/files/${rest[0]}`)).toHaveLength(1); // saved the first time, so it is fetched once
    expect(mock.calls("GET", `/files/${first}`)).toHaveLength(2);
  });

  it("asset.approved falls back to the asset in the event when the GET finds nothing", async () => {
    const ctx = setup(mock); // no fixture loaded: GET answers 404
    const body = fixture("asset.approved");
    await ctx.client.onAssetEvent("EXAMPLE-CHAIR-01", "asset.approved", JSON.parse(body));
    const links = JSON.parse(readFileSync(join(ctx.outDir, "EXAMPLE-CHAIR-01", "links.json"), "utf8"));
    expect(links).toMatchObject({ status: "delivered", glbUrl: expect.stringContaining(".glb") });
  });

  it("answers 503 (so CharpstAR retries) when the asset can't be fetched", async () => {
    const ctx = setup(mock);
    server = await startWebhookServer({ port: 0, host: "127.0.0.1", path: "/charpstar", secret: SECRET, log: silentLogger }, handlersOf(ctx));
    for (let i = 0; i < 6; i++) mock.force(500, { error: { code: "internal_error", message: "boom" } }, {}, /assets\/EXAMPLE-CHAIR-01/);
    const body = fixture("asset.images.updated");
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/charpstar`, {
      method: "POST",
      headers: { "CharpstAR-Event": "asset.images.updated", "CharpstAR-Delivery": "x1", "CharpstAR-Signature": sign(SECRET, body, Math.floor(Date.now() / 1000)) },
      body,
    });
    expect(res.status).toBe(503);
    expect(ctx.state.deliveries).toEqual([]);
  });
});
