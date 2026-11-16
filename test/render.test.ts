import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCatalogue } from "../src/catalogue.ts";
import { saveJobOutputs } from "../src/download.ts";
import { silentLogger } from "../src/log.ts";
import type { Job, PackshotJob, Preset } from "../src/platform.ts";
import { MissingScopeError, PlatformAuthError } from "../src/platform.ts";
import { ROOT, setup } from "./helpers.ts";
import { MOCK_SCOPES, MockPlatform } from "./mockPlatform.ts";

const CHAIR = "EXAMPLE-CHAIR-01"; // delivered
const TABLE = "EXAMPLE-TABLE-01"; // in production: no delivered model yet
const FILES = ["09521234567806_C1C0.png", "09521234567806_C2C0.png", "09521234567806_C7C0.png"];
const packshot = (articleId: string): PackshotJob => ({ type: "packshot", articleId });
const jobPosts = (mock: MockPlatform) => mock.calls("POST", "/api/v1/jobs");

let mock: MockPlatform;
beforeEach(async () => {
  mock = await new MockPlatform().start();
  mock.loadAssetFixture(CHAIR);
  mock.loadAssetFixture(TABLE);
  mock.presets = mock.fixture<{ presets: Preset[] }>("presets.json").presets;
});
afterEach(() => mock.stop());

describe("presets and jobs: the API wrapper", () => {
  it("lists the render presets of one type", async () => {
    const { platform } = setup(mock);
    expect((await platform.listPresets("packshot")).map((p) => p.name)).toEqual(["Armchairs and lounge chairs", "Marketplace (GS1)"]);
    expect(await platform.listPresets("scene")).toEqual([]);
    expect(mock.calls("GET", "/api/v1/presets").map((c) => c.path)).toEqual(["/api/v1/presets?type=packshot", "/api/v1/presets?type=scene"]);
  });

  it("starts several jobs in one call with an Idempotency-Key; each job gets its own answer", async () => {
    const { platform } = setup(mock);
    const r = await platform.createJobs([packshot(CHAIR), packshot(TABLE), packshot("NOT-THERE")], "run-1");
    expect(r[0]).toMatchObject({ articleId: CHAIR, type: "packshot", status: "queued", httpStatus: 202 });
    expect(r[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r[1]).toMatchObject({ articleId: TABLE, error: { code: "not_ready" }, httpStatus: 409 });
    expect(r[2]).toMatchObject({ articleId: "NOT-THERE", error: { code: "not_found" }, httpStatus: 404 });
    expect(jobPosts(mock)).toHaveLength(1);
    expect(jobPosts(mock)[0].body).toEqual({ jobs: [packshot(CHAIR), packshot(TABLE), packshot("NOT-THERE")] });
    expect(jobPosts(mock)[0].headers["idempotency-key"]).toBe("run-1");
  });

  it("the same key and body starts nothing twice; the same key with another body is refused", async () => {
    const { platform } = setup(mock);
    const first = await platform.createJobs([packshot(CHAIR)], "run-1");
    expect(await platform.createJobs([packshot(CHAIR)], "run-1")).toEqual(first);
    expect(mock.jobs.size).toBe(1);
    const other = await platform.createJobs([packshot(CHAIR), packshot(CHAIR)], "run-1");
    expect(other.map((r) => [r.error?.code, r.httpStatus])).toEqual([
      ["idempotency_conflict", 409],
      ["idempotency_conflict", 409],
    ]);
    expect(mock.jobs.size).toBe(1);
  });

  it("sends more than 50 jobs in several requests, each with its own key", async () => {
    const { platform } = setup(mock);
    const r = await platform.createJobs(Array.from({ length: 101 }, () => packshot(CHAIR)), "run-1");
    expect(r.filter((x) => x.id)).toHaveLength(101);
    expect(jobPosts(mock).map((c) => [(c.body as { jobs: unknown[] }).jobs.length, c.headers["idempotency-key"]])).toEqual([
      [50, "run-1"],
      [50, "run-1-2"],
      [1, "run-1-3"],
    ]);
  });

  it("a retry after a 500 carries the same Idempotency-Key", async () => {
    const { platform, sleeps } = setup(mock);
    mock.force(500, { error: { code: "internal_error", message: "boom" } }, {}, /jobs/);
    expect((await platform.createJobs([packshot(CHAIR)], "run-1"))[0].id).toBeTruthy();
    expect(sleeps).toEqual([1000]);
    expect(jobPosts(mock).map((c) => c.headers["idempotency-key"])).toEqual(["run-1", "run-1"]);
  });

  it("reads a job until it has its outputs; an unknown job is null", async () => {
    const { platform } = setup(mock);
    const [{ id }] = await platform.createJobs([packshot(CHAIR)], "run-1");
    expect(await platform.getJob(id!)).toMatchObject({ id, status: "running", outputs: [] });
    const done = await platform.getJob(id!);
    expect(done).toMatchObject({ status: "succeeded", articleId: CHAIR, error: null });
    expect(done?.outputs.map((o) => o.fileName)).toEqual(FILES);
    expect(await platform.getJob("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("cancels a queued job; a job that has started answers not_cancellable", async () => {
    const { platform } = setup(mock);
    const [a, b] = await platform.createJobs([packshot(CHAIR), packshot(CHAIR)], "run-1");
    expect((await platform.cancelJob(a.id!)).job).toMatchObject({ id: a.id, status: "cancelled" });
    expect((await platform.cancelJob(a.id!)).job?.status).toBe("cancelled"); // cancelling again answers the job again
    await platform.getJob(b.id!); // now running
    expect(await platform.cancelJob(b.id!)).toMatchObject({ job: null, error: { code: "not_cancellable", details: { status: "running" } } });
    expect((await platform.cancelJob("00000000-0000-4000-8000-000000000000")).error?.code).toBe("not_found");
  });

  it("lists jobs with filters and follows nextCursor", async () => {
    const { platform } = setup(mock);
    const started = await platform.createJobs([packshot(CHAIR), packshot(CHAIR)], "run-1");
    mock.pageSize = 1;
    const jobs = await platform.listJobs({ articles: [CHAIR], status: "queued" });
    expect(jobs.map((j) => j.id)).toEqual([started[1].id, started[0].id]); // newest first
    const calls = mock.calls("GET", "/api/v1/jobs?");
    expect(calls).toHaveLength(2);
    expect(calls[0].path).toBe(`/api/v1/jobs?articles=${CHAIR}&status=queued`);
    expect(calls[1].path).toContain("&cursor=");
    expect(await platform.listJobs({ status: "failed" })).toEqual([]);
  });
});

describe("render: a packshot job per article -> out/<article>/<fileName>", () => {
  it("starts the jobs, waits for them, saves each output under its fileName, and reports not_ready per article", async () => {
    const { client, outDir, logs, sleeps } = setup(mock);
    const s = await client.render([CHAIR, TABLE, "NOT-THERE", CHAIR]);
    expect(s).toEqual({ ok: false, total: 3, started: 1, saved: [CHAIR], notReady: [TABLE], refused: ["NOT-THERE: not_found"], failed: [], waiting: [] });

    expect(jobPosts(mock)).toHaveLength(1);
    expect(jobPosts(mock)[0].body).toEqual({ jobs: [packshot(CHAIR), packshot(TABLE), packshot("NOT-THERE")] });
    expect(jobPosts(mock)[0].headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(sleeps).toEqual([10_000, 10_000]); // one wait before each read of the job
    expect(mock.calls("GET", "/api/v1/jobs/")).toHaveLength(2);

    const dir = join(outDir, CHAIR);
    for (const f of FILES) expect(statSync(join(dir, f)).size).toBe(73);
    const [job] = [...mock.jobs.values()];
    const index = JSON.parse(readFileSync(join(dir, "outputs.json"), "utf8")) as Array<{ fileName: string; jobId: string; view: string }>;
    expect(index.map((o) => [o.fileName, o.view, o.jobId])).toEqual([
      [FILES[0], "front", job.id],
      [FILES[1], "left", job.id],
      [FILES[2], "back", job.id],
    ]);
    expect(existsSync(join(outDir, TABLE))).toBe(false);

    const notReady = logs.find((l) => l.msg === "render.not_ready");
    expect(notReady).toMatchObject({ level: "warn", fields: { article: TABLE, message: `${TABLE} has no delivered model yet; packshots are made from it.` } });
    expect(logs.find((l) => l.msg === "render.refused")?.fields).toMatchObject({ article: "NOT-THERE", httpStatus: 404, error: { code: "not_found" } });
    expect(logs.at(-1)).toMatchObject({ level: "warn", msg: "render.done" });

    // The same folder pull uses: its files sit next to the job's.
    await client.pull([CHAIR]);
    expect(existsSync(join(dir, "links.json"))).toBe(true);
    expect(existsSync(join(dir, FILES[0]))).toBe(true);
  });

  it("is ok when every article was saved", async () => {
    const { client, logs } = setup(mock);
    expect(await client.render([CHAIR])).toMatchObject({ ok: true, saved: [CHAIR] });
    expect(logs.at(-1)).toMatchObject({ level: "info", msg: "render.done" });
  });

  it("--preset names one of the account's presets in every job", async () => {
    const { client } = setup(mock);
    await client.render([CHAIR], { preset: "Marketplace (GS1)" });
    expect(mock.calls("GET", "/api/v1/presets?type=packshot")).toHaveLength(1);
    expect(jobPosts(mock)[0].body).toEqual({ jobs: [{ type: "packshot", articleId: CHAIR, options: { preset: "Marketplace (GS1)" } }] });
  });

  it("--preset with an unknown name starts nothing and lists the presets there are", async () => {
    const { client, logs } = setup(mock);
    const s = await client.render([CHAIR], { preset: "No such look" });
    expect(s).toMatchObject({ ok: false, started: 0, refused: [`${CHAIR}: unknown_preset`] });
    expect(jobPosts(mock)).toHaveLength(0);
    expect(logs.find((l) => l.msg === "render.unknown_preset")?.fields).toEqual({ preset: "No such look", presets: ["Armchairs and lounge chairs", "Marketplace (GS1)"] });
  });

  it("a job that fails is reported with its error and saves nothing", async () => {
    const { client, outDir, logs } = setup(mock);
    mock.jobEnds.set(CHAIR, "failed");
    const s = await client.render([CHAIR]);
    expect(s).toMatchObject({ ok: false, saved: [], failed: [`${CHAIR}: internal_error`] });
    expect(logs.find((l) => l.msg === "render.failed")).toMatchObject({ level: "error", fields: { article: CHAIR, error: { code: "internal_error" } } });
    expect(existsSync(join(outDir, CHAIR))).toBe(false);
  });

  it("stops waiting after the wait limit and says the job is still running", async () => {
    const { client, logs, sleeps } = setup(mock, { renderWaitMs: 30_000 });
    mock.jobDoneOnRead = Infinity;
    const s = await client.render([CHAIR]);
    expect(s).toMatchObject({ ok: false, started: 1, saved: [], waiting: [CHAIR] });
    expect(sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(mock.calls("GET", "/api/v1/jobs/")).toHaveLength(3);
    expect(logs.find((l) => l.msg === "render.still_running")?.fields).toMatchObject({ article: CHAIR, waited_ms: 30_000 });
  });

  it("--dry-run prints the request body and makes no calls", async () => {
    const { client, printed, outDir } = setup(mock, { dryRun: true });
    const s = await client.render([CHAIR, TABLE], { preset: "Marketplace (GS1)" });
    expect(s.started).toBe(0);
    expect(printed).toHaveLength(1);
    expect(JSON.parse(printed[0])).toEqual({
      jobs: [
        { type: "packshot", articleId: CHAIR, options: { preset: "Marketplace (GS1)" } },
        { type: "packshot", articleId: TABLE, options: { preset: "Marketplace (GS1)" } },
      ],
    });
    expect(mock.requests).toHaveLength(0);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe("saving job outputs", () => {
  const deps = { fetch: (u: string, i?: RequestInit) => fetch(u, i), sleep: async () => {}, log: silentLogger };
  const finishedJob = () => {
    const job = mock.fixture<Job>("jobs/packshot.succeeded.json");
    for (const o of job.outputs) mock.files.set(o.fileName, readFileSync(join(ROOT, "example-images", "chair.png")));
    return job;
  };

  it("does not download a file twice, and downloads it again when the same name has a new output id", async () => {
    const { outDir } = setup(mock);
    const job = finishedJob();
    expect((await saveJobOutputs(job, outDir, deps)).downloaded).toEqual(FILES);
    expect(await saveJobOutputs(job, outDir, deps)).toMatchObject({ downloaded: [], skipped: FILES });
    expect(mock.calls("GET", "/files/")).toHaveLength(3);

    // A new picture of the front: the file name stays, the id is new.
    const again: Job = { ...job, id: "8d2c4b6a-1e3f-4a5b-9c7d-0e1f2a3b4c5d", outputs: [{ ...job.outputs[0], id: "new-output-id" }] };
    expect((await saveJobOutputs(again, outDir, deps)).downloaded).toEqual([FILES[0]]);
    const index = JSON.parse(readFileSync(join(outDir, CHAIR, "outputs.json"), "utf8")) as Array<{ id: string; jobId: string }>;
    expect(index).toHaveLength(3);
    expect(index[0]).toMatchObject({ id: "new-output-id", jobId: again.id });
  });

  it("refuses a file name that could leave the article's folder", async () => {
    const { outDir } = setup(mock);
    const job = finishedJob();
    job.outputs = [{ ...job.outputs[0], fileName: "../escape.png" }, { ...job.outputs[1], fileName: "links.json" }, job.outputs[2]];
    const r = await saveJobOutputs(job, outDir, deps);
    expect(r.failed).toEqual(["../escape.png: unsafe file name", "links.json: unsafe file name"]);
    expect(r.downloaded).toEqual([FILES[2]]);
    expect(existsSync(join(outDir, "escape.png"))).toBe(false);
  });
});

describe("a key without the scope a command needs", () => {
  const without = (scope: string) => void (mock.scopes = MOCK_SCOPES.filter((s) => s !== scope));

  it("render names jobs:write", async () => {
    const { client } = setup(mock);
    without("jobs:write");
    const p = client.render([CHAIR]);
    await expect(p).rejects.toBeInstanceOf(MissingScopeError);
    await expect(p).rejects.toMatchObject({ scope: "jobs:write" });
    await expect(p).rejects.toThrow("The API key does not have the scope jobs:write, which POST /api/v1/jobs needs.");
  });

  it("render names jobs:read when the key may start jobs but not read them", async () => {
    const { client } = setup(mock);
    without("jobs:read");
    await expect(client.render([CHAIR])).rejects.toMatchObject({ scope: "jobs:read" });
  });

  it("orders names products:read", async () => {
    const { client } = setup(mock);
    without("products:read");
    await expect(client.listOrders()).rejects.toThrow(/scope products:read, which GET \/api\/v1\/orders needs/);
    await expect(client.showOrder("4d3c2b1a-0000-4000-8000-000000000011")).rejects.toMatchObject({ scope: "products:read" });
  });

  it("pull and poll name assets:read; push names products:write", async () => {
    const { client } = setup(mock);
    without("assets:read");
    await expect(client.pull([CHAIR])).rejects.toThrow(/scope assets:read, which GET \/api\/v1\/assets needs/);
    await expect(client.pollOnce()).rejects.toMatchObject({ scope: "assets:read" });
    await expect(client.onAssetEvent(CHAIR, "asset.images.updated", {})).rejects.toMatchObject({ scope: "assets:read" });
    without("products:write");
    await expect(client.push(loadCatalogue(join(ROOT, "catalogue.example.json")), ROOT)).rejects.toMatchObject({ scope: "products:write" });
  });

  it("another 403 (the API is not switched on) stays a plain key error", async () => {
    const { platform } = setup(mock);
    mock.force(403, { error: { code: "forbidden", message: "The API is not switched on for this account.", details: { reason: "client_not_enabled" } } });
    const e = await platform.listOrders().catch((err: unknown) => err);
    expect(e).toBeInstanceOf(PlatformAuthError);
    expect(e).not.toBeInstanceOf(MissingScopeError);
    expect((e as Error).message).toContain("client_not_enabled");
  });
});
