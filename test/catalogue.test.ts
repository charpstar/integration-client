import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { loadCatalogue, parseCsv, toPayload } from "../src/catalogue.ts";
import { ROOT } from "./helpers.ts";

const json = loadCatalogue(join(ROOT, "catalogue.example.json"));
const csv = loadCatalogue(join(ROOT, "catalogue.example.csv"));

describe("catalogue -> POST /api/v1/products payload (camelCase)", () => {
  it("JSON and CSV examples describe the same three products", () => {
    const hashes = (rows: typeof json) =>
      rows.map((r) => {
        const p = toPayload(r);
        if (!p.ok) throw new Error(p.reason);
        return p.hash;
      });
    expect(json).toHaveLength(3);
    // The JSON adds a material on one variant; everything else matches the CSV.
    const jsonNoMaterial = json.map((r) => ({ ...r, variants: r.variants?.map(({ material: _m, ...v }) => v) }));
    expect(hashes(csv)).toEqual(hashes(jsonNoMaterial));
  });

  it("maps fields to the contract's names and sends images as {url}", () => {
    const r = toPayload(json[1]);
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload).toEqual({
      articleId: "EXAMPLE-TABLE-01",
      externalId: "EXAMPLE-TABLE-01", // defaults to the article
      source: "api",
      name: "Example Dining Table, oak 140",
      category: "Tables",
      dimensionsCm: { w: 140, h: 75, d: 90 },
      variants: [{ code: "OAK", colour: "Oak", material: "Solid oak" }],
      referenceImages: [{ url: "https://cdn.example.com/images/table-front.jpg" }, { url: "https://cdn.example.com/images/table-side.jpg" }],
      source3dUrl: null,
      productLink: null,
      active: true,
    });
    expect(JSON.stringify(r.payload)).not.toMatch(/article_id|reference_images|base64|_url/);
  });

  it("passes variant articleId and subcategory through", () => {
    const r = toPayload({ articleId: "A1", name: "n", subcategory: "Desks", variants: [{ code: "W", articleId: "A1-W", colour: "White" }] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload).toMatchObject({ subcategory: "Desks", variants: [{ code: "W", articleId: "A1-W", colour: "White" }] });
  });

  it("omits dimensions when missing or out of range and refuses bad article numbers", () => {
    const lamp = toPayload(json[2]);
    if (!lamp.ok) throw new Error(lamp.reason);
    expect(lamp.payload).not.toHaveProperty("dimensionsCm");
    const huge = toPayload({ articleId: "A1", name: "n", dimensionsCm: { w: 10_000, h: 1, d: 1 } });
    if (!huge.ok) throw new Error(huge.reason);
    expect(huge.payload).not.toHaveProperty("dimensionsCm");
    expect(huge.warnings[0]).toMatch(/dimensionsCm left out/);
    for (const bad of ["", "has space", "a/b", "-x", "x".repeat(65)]) expect(toPayload({ articleId: bad, name: "n" }).ok).toBe(false);
  });

  it("skips local files and non-https images with a warning (URLs only, no base64)", () => {
    const r = toPayload({
      articleId: "A1",
      name: "n",
      images: ["example-images/chair.png", "/abs/photo.jpg", "http://insecure.example.com/a.jpg", "https://cdn.example.com/ok.jpg"],
    });
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.referenceImages).toEqual([{ url: "https://cdn.example.com/ok.jpg" }]);
    expect(r.warnings).toEqual([
      "image example-images/chair.png: skipped, local files can't be sent; publish it at an https URL and list that URL instead",
      "image /abs/photo.jpg: skipped, local files can't be sent; publish it at an https URL and list that URL instead",
      "image http://insecure.example.com/a.jpg: skipped, only https URLs are accepted",
    ]);
  });

  it("sends at most 10 image URLs", () => {
    const r = toPayload({ articleId: "A1", name: "n", images: Array.from({ length: 12 }, (_, i) => `https://cdn.example.com/${i}.jpg`) });
    if (!r.ok) throw new Error(r.reason);
    expect(r.payload.referenceImages).toHaveLength(10);
    expect(r.warnings).toEqual(["only the first 10 image URLs are sent"]);
  });

  it("hash changes with content, not with key order", () => {
    const a = toPayload({ articleId: "A1", name: "Chair", category: "C" });
    const b = toPayload({ category: "C", name: "Chair", articleId: "A1" });
    const c = toPayload({ articleId: "A1", name: "Chair 2", category: "C" });
    const d = toPayload({ articleId: "A1", name: "Chair", category: "C", images: ["https://cdn.example.com/new.jpg"] });
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error("map failed");
    expect(a.hash).toBe(b.hash);
    expect(a.hash).not.toBe(c.hash);
    expect(a.hash).not.toBe(d.hash);
  });

  it("parses quoted CSV cells, escaped quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n')).toEqual([["a", "b"], ["x, y", 'say "hi"']]);
  });
});
