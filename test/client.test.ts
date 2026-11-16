import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCatalogue } from "../src/catalogue.ts";
import { PlatformAuthError } from "../src/platform.ts";
import { runSmoke } from "../src/smoke.ts";
import { ROOT, setup } from "./helpers.ts";
import { MOCK_CLIENT, MOCK_SCOPES, MockPlatform, TEST_KEY } from "./mockPlatform.ts";

const catalogue = () => loadCatalogue(join(ROOT, "catalogue.example.json"));
let mock: MockPlatform;
beforeEach(async () => {
  mock = await new MockPlatform().start();
});
afterEach(() => mock.stop());

describe("me", () => {
  it("returns {client:{id,name}, keyPrefix, scopes}", async () => {
    const { platform } = setup(mock);
    expect(await platform.me()).toEqual({ client: MOCK_CLIENT, keyPrefix: TEST_KEY.slice(0, 12), scopes: MOCK_SCOPES });
  });
});

describe("push: catalogue -> POST /api/v1/products", () => {
  it("creates all three with camelCase bodies, then sends nothing when nothing changed", async () => {
    const { client, state, stateFile } = setup(mock);
    const first = await client.push(catalogue(), ROOT);
    expect(first.results).toEqual({ created: 3 });
    expect(first.accepted).toEqual(["EXAMPLE-CHAIR-01", "EXAMPLE-TABLE-01", "EXAMPLE-LAMP-01"]);
    const posted = mock.postedProducts();
    expect(posted.map((p) => p.articleId)).toEqual(["EXAMPLE-CHAIR-01", "EXAMPLE-TABLE-01", "EXAMPLE-LAMP-01"]);
    expect(posted[0]).toMatchObject({
      externalId: "erp-10001",
      source: "api",
      dimensionsCm: { w: 72, h: 81, d: 78 },
      referenceImages: [{ url: "https://cdn.example.com/images/chair-front.png" }],
      productLink: "https://shop.example.com/products/lounge-chair",
      source3dUrl: null,
    });
    expect(Object.keys(state.products)).toHaveLength(3);
    expect(existsSync(stateFile)).toBe(true);

    const second = await client.push(catalogue(), ROOT);
    expect(second).toMatchObject({ sent: 0, skipped_unchanged: 3 });
    expect(mock.calls("POST", "/api/v1/products")).toHaveLength(1);
  });

  it("sends only the product that changed (result: updated)", async () => {
    const { client } = setup(mock);
    await client.push(catalogue(), ROOT);
    const rows = catalogue();
    rows[0].name = "Example Lounge Chair, navy";
    const s = await client.push(rows, ROOT);
    expect(s).toMatchObject({ sent: 1, results: { updated: 1 }, skipped_unchanged: 2 });
  });

  it("is safe to repeat without local state: the platform answers unchanged", async () => {
    const a = setup(mock);
    await a.client.push(catalogue(), ROOT);
    const b = setup(mock); // fresh state.json, e.g. a second machine
    expect((await b.client.push(catalogue(), ROOT)).results).toEqual({ unchanged: 3 });
  });

  it("207 with a 409 conflict_other_client item: refused, not saved, sent again on the next push", async () => {
    const { client, state, logs } = setup(mock);
    mock.taken.add("EXAMPLE-LAMP-01");
    const s = await client.push(catalogue(), ROOT);
    expect(s.results).toEqual({ created: 2, refused: 1 });
    expect(s.refused).toEqual(["EXAMPLE-LAMP-01: conflict_other_client"]);
    expect(state.products["EXAMPLE-LAMP-01"]).toBeUndefined();
    const lamp = logs.find((l) => l.msg === "push.result" && l.fields?.article === "EXAMPLE-LAMP-01");
    expect(lamp?.fields).toMatchObject({ result: "refused", httpStatus: 409, error: { code: "conflict_other_client" } });

    mock.taken.clear();
    const again = await client.push(catalogue(), ROOT);
    expect(again).toMatchObject({ sent: 1, results: { created: 1 } });
  });

  it("a batch where every item fails the same way (HTTP 409 with results) refuses each item", async () => {
    const { client } = setup(mock);
    mock.taken.add("EXAMPLE-LAMP-01");
    const s = await client.push([catalogue()[2]], ROOT);
    expect(s.refused).toEqual(["EXAMPLE-LAMP-01: conflict_other_client"]);
  });

  it("400 validation_failed for the whole request refuses every product in it", async () => {
    const { client } = setup(mock);
    mock.force(400, { error: { code: "validation_failed", message: "products must hold 1 to 50 products." } }, {}, /products/);
    const s = await client.push(catalogue(), ROOT);
    expect(s.refused).toEqual(["EXAMPLE-CHAIR-01: validation_failed", "EXAMPLE-TABLE-01: validation_failed", "EXAMPLE-LAMP-01: validation_failed"]);
  });

  it("413 too_large refuses the chunk", async () => {
    const { client } = setup(mock);
    mock.force(413, { error: { code: "too_large", message: "The body is over 4,000,000 bytes." } }, {}, /products/);
    const s = await client.push(catalogue(), ROOT);
    expect(s.results).toEqual({ refused: 3 });
    expect(s.refused[0]).toBe("EXAMPLE-CHAIR-01: too_large");
  });

  it("429: waits for Retry-After and retries", async () => {
    const { client, sleeps } = setup(mock);
    mock.force(429, { error: { code: "rate_limited", message: "Slow down.", details: { retryAfter: 3 } } }, { "Retry-After": "3" });
    const s = await client.push(catalogue(), ROOT);
    expect(s.results).toEqual({ created: 3 });
    expect(sleeps).toEqual([3000]);
  });

  it("401: stops with a clear key error naming the error code", async () => {
    const { client } = setup(mock, { key: "cs_live_wrong" });
    const p = client.push(catalogue(), ROOT);
    await expect(p).rejects.toBeInstanceOf(PlatformAuthError);
    await expect(p).rejects.toThrow(/unauthorized/);
  });

  it("--dry-run prints the three camelCase payloads and makes no calls, writes no state", async () => {
    const { client, printed, stateFile } = setup(mock, { dryRun: true });
    const s = await client.push(catalogue(), ROOT);
    expect(s.sent).toBe(0);
    expect(printed).toHaveLength(3);
    expect(JSON.parse(printed[0])).toMatchObject({ articleId: "EXAMPLE-CHAIR-01", referenceImages: [{ url: "https://cdn.example.com/images/chair-front.png" }] });
    expect(mock.requests).toHaveLength(0);
    expect(existsSync(stateFile)).toBe(false);
  });
});

describe("pull / poll: assets -> out/<article>/", () => {
  it("pull uses ?articles=, logs unknown ones, saves links + approved images and videos, primary copy", async () => {
    const { client, outDir, logs } = setup(mock);
    mock.loadAssetFixture("EXAMPLE-CHAIR-01");
    mock.loadAssetFixture("EXAMPLE-TABLE-01");
    await client.pull(["EXAMPLE-CHAIR-01", "EXAMPLE-TABLE-01", "NOT-THERE"]);
    expect(mock.calls("GET", "/api/v1/assets?articles=EXAMPLE-CHAIR-01,EXAMPLE-TABLE-01,NOT-THERE")).toHaveLength(1);
    expect(logs.filter((l) => l.msg === "pull.unknown_article").map((l) => l.fields?.article)).toEqual(["NOT-THERE"]);

    const dir = join(outDir, "EXAMPLE-CHAIR-01");
    const links = JSON.parse(readFileSync(join(dir, "links.json"), "utf8"));
    expect(links).toMatchObject({
      articleId: "EXAMPLE-CHAIR-01",
      status: "delivered",
      glbUrl: expect.stringContaining(".glb"),
      usdzUrl: expect.stringContaining(".usdz"),
      variations: [{ articleId: "EXAMPLE-CHAIR-01-GREY", status: "in_production" }],
    });
    expect(links.embedSnippet).toContain("charpstar-viewer");
    expect(statSync(join(dir, "images", "img_packshot_front.png")).size).toBe(73);
    expect(statSync(join(dir, "images", "img_render_side.jpg")).size).toBe(776); // bytes: null in the API, still downloaded
    expect(existsSync(join(dir, "images", "vid_turntable.mp4"))).toBe(true);
    expect(existsSync(join(dir, "images", "img_render_draft.jpg"))).toBe(false); // not approved
    expect(statSync(join(dir, "primary.png")).size).toBe(73);
    const index = JSON.parse(readFileSync(join(dir, "images.json"), "utf8"));
    expect(index.map((i: { file: string }) => i.file)).toEqual(["images/img_packshot_front.png", "images/img_render_side.jpg", "images/vid_turntable.mp4"]);
    expect(index[2].posterUrl).toContain("/files/");

    const table = JSON.parse(readFileSync(join(outDir, "EXAMPLE-TABLE-01", "links.json"), "utf8"));
    expect(table).toMatchObject({ status: "in_production", glbUrl: null, viewerUrl: null, embedSnippet: null });
  });

  it("does not download a file twice", async () => {
    const { client } = setup(mock);
    mock.loadAssetFixture("EXAMPLE-CHAIR-01");
    await client.pull(["EXAMPLE-CHAIR-01"]);
    await client.pull(["EXAMPLE-CHAIR-01"]);
    expect(mock.calls("GET", "/files/")).toHaveLength(3); // 3 approved files, fetched once each
  });

  it("asks for more than 100 articles in chunks", async () => {
    const { platform } = setup(mock);
    const r = await platform.getAssets(Array.from({ length: 150 }, (_, i) => `A${i}`));
    expect(mock.calls("GET", "/api/v1/assets?articles=")).toHaveLength(2);
    expect(r.unknown).toHaveLength(150);
  });

  it("getAsset: 404 not_found is null", async () => {
    const { platform } = setup(mock);
    expect(await platform.getAsset("NOT-THERE")).toBeNull();
  });

  it("poll: first since is the epoch, cursor from updatedAt (minus 2 min), only changes after that", async () => {
    const { client, state } = setup(mock);
    mock.loadAssetFixture("EXAMPLE-CHAIR-01");
    mock.loadAssetFixture("EXAMPLE-TABLE-01");
    expect(await client.pollOnce()).toMatchObject({ since: "1970-01-01T00:00:00.000Z", changed: 2, saved: 2, pages: 1 });
    expect(state.assetsCursor).toBe("2026-10-20T09:30:00.000Z");

    expect(await client.pollOnce()).toMatchObject({ changed: 1 }); // the 2-minute overlap re-asks for the chair
    expect(mock.calls("GET", "/api/v1/assets?since=")[1].path).toBe("/api/v1/assets?since=2026-10-20T09%3A28%3A00.000Z");

    mock.assets.get("EXAMPLE-TABLE-01")!.updatedAt = "2026-10-21T08:00:00.000Z";
    mock.assets.get("EXAMPLE-TABLE-01")!.status = "in_review";
    expect(await client.pollOnce()).toMatchObject({ changed: 2, saved: 2 }); // the table + the chair still in the overlap
    expect(state.assetsCursor).toBe("2026-10-21T08:00:00.000Z");
    expect(await client.pollOnce()).toMatchObject({ changed: 1 }); // now only the table's overlap
  });

  it("poll: follows nextCursor until it is null", async () => {
    const { client } = setup(mock);
    mock.pageSize = 1;
    mock.loadAssetFixture("EXAMPLE-CHAIR-01");
    mock.loadAssetFixture("EXAMPLE-TABLE-01");
    const r = await client.pollOnce();
    expect(r).toMatchObject({ changed: 2, pages: 2, articles: ["EXAMPLE-TABLE-01", "EXAMPLE-CHAIR-01"] }); // oldest change first
    const calls = mock.calls("GET", "/api/v1/assets?since=");
    expect(calls).toHaveLength(2);
    expect(calls[0].path).not.toContain("cursor=");
    expect(calls[1].path).toMatch(/&cursor=[A-Za-z0-9_-]+$/);
  });

  it("poll: the server clock moves the cursor past changes whose updatedAt is older", async () => {
    const { client, state } = setup(mock);
    mock.loadAssetFixture("EXAMPLE-TABLE-01");
    mock.serverDate = "2026-10-25T00:00:00.000Z";
    await client.pollOnce();
    expect(state.assetsCursor).toBe("2026-10-25T00:00:00.000Z");
    expect(await client.pollOnce()).toMatchObject({ since: "2026-10-24T23:58:00.000Z", changed: 0 });
  });

  it("poll: a failed download is retried on the next poll", async () => {
    const { client, state } = setup(mock);
    mock.loadAssetFixture("EXAMPLE-CHAIR-01");
    const bytes = mock.files.get("img_render_side.jpg")!;
    mock.files.delete("img_render_side.jpg");
    expect((await client.pollOnce()).failed).toEqual(["EXAMPLE-CHAIR-01"]);
    expect(state.pendingDownloads).toEqual(["EXAMPLE-CHAIR-01"]);

    mock.files.set("img_render_side.jpg", bytes);
    mock.assets.get("EXAMPLE-CHAIR-01")!.updatedAt = "2026-10-20T09:00:00.000Z"; // not "changed" any more
    expect((await client.pollOnce()).failed).toEqual([]);
    expect(state.pendingDownloads).toEqual([]);
  });

  it("--dry-run pull downloads nothing and writes nothing", async () => {
    const { client, outDir } = setup(mock, { dryRun: true });
    mock.loadAssetFixture("EXAMPLE-CHAIR-01");
    await client.pull(["EXAMPLE-CHAIR-01"]);
    expect(mock.calls("GET", "/files/")).toHaveLength(0);
    expect(existsSync(outDir)).toBe(false);
  });
});

describe("smoke", () => {
  it("me -> push -> getAsset each -> one since poll, as a JSON summary", async () => {
    const { platform } = setup(mock);
    // The mock has no production line: make the pushed articles readable as in a real platform.
    for (const a of ["EXAMPLE-CHAIR-01", "EXAMPLE-TABLE-01", "EXAMPLE-LAMP-01"])
      mock.assets.set(a, { articleId: a, status: "received", updatedAt: "2026-10-01T00:00:30.000Z", images: [], variations: [] });
    const s = await runSmoke(platform, catalogue(), mock.base);
    expect(s.errors).toEqual([]);
    expect(s.ok).toBe(true);
    expect(s.me?.client).toEqual(MOCK_CLIENT);
    expect(s.push.results.map((r) => r.result)).toEqual(["created", "created", "created"]);
    expect(s.assets.map((a) => a.found)).toEqual([true, true, true]);
    expect(s.poll).toMatchObject({ since: "2026-09-30T23:58:00.000Z", pages: 1, changed: 3 });
    expect(s.poll?.pushedSeen).toHaveLength(3);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("reports a refused product and a missing asset as errors", async () => {
    const { platform } = setup(mock);
    mock.taken.add("EXAMPLE-LAMP-01");
    const s = await runSmoke(platform, catalogue(), mock.base);
    expect(s.ok).toBe(false);
    expect(s.errors).toContain("push EXAMPLE-LAMP-01: conflict_other_client");
    expect(s.errors).toContain("asset EXAMPLE-CHAIR-01: 404 right after an accepted push");
  });
});
