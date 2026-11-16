// Your product catalogue -> POST /api/v1/products payloads.
//
// This is the part you replace: here products come from a local JSON or CSV file; in your system they
// come from your ERP/PIM. Everything after toPayload() (idempotency, sending, retries) stays the same.
//
// JSON: [ {...} ] or { "products": [ {...} ] } with the fields of CatalogueRow below (the API's own
//       camelCase names, plus `images` for reference photo URLs).
// CSV:  header row; columns article_id,name,category,width_cm,height_cm,depth_cm,colours,images,
//       product_link,active,external_id. Lists inside a cell use "|": colours "BLUE:Blue|GREY:Grey",
//       images "https://cdn.example.com/a.jpg|https://cdn.example.com/b.png".
//
// Reference images go by https URL only. The API does not take file uploads, so a local file path in
// `images` is skipped with a warning: put the photo somewhere public (your CDN, DAM, shop) first.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { MAX_IMAGES, sha256 } from "./image.ts";

/** Allowed article numbers: the article becomes a file name and the embed's data-articleid. */
export const ARTICLE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;
const HTTPS_RE = /^https:\/\/\S+$/i;
const HTTP_RE = /^https?:\/\/\S+$/i;

export type Variant = { code: string; articleId?: string | null; colour?: string | null; material?: string | null; name?: string | null };
export type Dimensions = { w: number; h: number; d: number };

export type CatalogueRow = {
  articleId: string;
  name: string;
  externalId?: string;
  category?: string | null;
  subcategory?: string | null;
  dimensionsCm?: Dimensions | null;
  variants?: Variant[];
  /** Reference photos as public https URLs (sent as referenceImages). */
  images?: string[];
  productLink?: string | null;
  source3dUrl?: string | null;
  active?: boolean;
};

export type ReferenceImage = { url: string };

/** The body of one product in POST /api/v1/products. */
export type ProductPayload = {
  articleId: string;
  externalId: string;
  source: "api";
  name: string;
  category: string | null;
  subcategory?: string | null;
  dimensionsCm?: Dimensions;
  variants: Variant[];
  referenceImages: ReferenceImage[];
  source3dUrl: string | null;
  productLink: string | null;
  active: boolean;
};

export type Mapped = { ok: true; payload: ProductPayload; hash: string; warnings: string[] } | { ok: false; article: string; reason: string };

export function loadCatalogue(file: string): CatalogueRow[] {
  const text = readFileSync(file, "utf8");
  if (/\.csv$/i.test(file)) return parseCsvCatalogue(text);
  const json = JSON.parse(text) as CatalogueRow[] | { products: CatalogueRow[] };
  return Array.isArray(json) ? json : json.products;
}

export function parseCsvCatalogue(text: string): CatalogueRow[] {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  const idx = (name: string) => header.findIndex((h) => h.trim().toLowerCase() === name);
  const col = (r: string[], name: string) => {
    const i = idx(name);
    return i === -1 ? "" : (r[i] ?? "").trim();
  };
  const list = (s: string) => s.split("|").map((x) => x.trim()).filter(Boolean);
  return rows
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => {
      const w = Number(col(r, "width_cm"));
      const h = Number(col(r, "height_cm"));
      const d = Number(col(r, "depth_cm"));
      const active = col(r, "active").toLowerCase();
      return {
        articleId: col(r, "article_id"),
        name: col(r, "name"),
        externalId: col(r, "external_id") || undefined,
        category: col(r, "category") || null,
        dimensionsCm: w > 0 && h > 0 && d > 0 ? { w, h, d } : null,
        variants: list(col(r, "colours")).map((v) => {
          const [code, ...rest] = v.split(":");
          const colour = rest.join(":").trim();
          return colour ? { code: code.trim(), colour } : { code: code.trim() };
        }),
        images: list(col(r, "images")),
        productLink: col(r, "product_link") || null,
        active: !["false", "0", "no"].includes(active),
      };
    });
}

/** Minimal RFC 4180 parser: commas, double-quoted cells, "" escapes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const validDims = (d: Dimensions | null | undefined): d is Dimensions =>
  !!d && [d.w, d.h, d.d].every((n) => typeof n === "number" && n > 0 && n < 10_000);

/**
 * One catalogue row -> payload + a hash of everything we send (for "only send what changed").
 * `_baseDir` is kept for custom mappers that resolve paths; the default mapper sends URLs only.
 */
export function toPayload(row: CatalogueRow, _baseDir?: string): Mapped {
  const article = (row.articleId ?? "").trim();
  if (!ARTICLE_RE.test(article)) return { ok: false, article, reason: `articleId "${article}" must match ${ARTICLE_RE}` };
  const warnings: string[] = [];
  const images: ReferenceImage[] = [];
  for (const ref of row.images ?? []) {
    if (HTTPS_RE.test(ref)) {
      if (images.length < MAX_IMAGES) images.push({ url: ref });
      continue;
    }
    if (/^[a-z]+:\/\//i.test(ref)) warnings.push(`image ${ref}: skipped, only https URLs are accepted`);
    else warnings.push(`image ${ref}: skipped, local files can't be sent; publish it at an https URL and list that URL instead`);
  }
  if ((row.images ?? []).filter((r) => HTTPS_RE.test(r)).length > MAX_IMAGES) warnings.push(`only the first ${MAX_IMAGES} image URLs are sent`);

  const dims = row.dimensionsCm;
  if (dims && !validDims(dims)) warnings.push("dimensionsCm left out: w, h and d must each be above 0 and below 10000");
  const link = row.productLink?.trim() || null;
  if (link && !HTTP_RE.test(link)) warnings.push(`productLink ${link}: must be an http(s) URL`);
  const src3d = row.source3dUrl?.trim() || null;
  if (src3d && !HTTPS_RE.test(src3d)) warnings.push(`source3dUrl ${src3d}: must be an https URL`);

  const payload: ProductPayload = {
    articleId: article,
    externalId: (row.externalId ?? "").trim() || article,
    source: "api",
    name: (row.name ?? "").trim().slice(0, 300) || article,
    category: row.category?.trim() || null,
    ...(row.subcategory?.trim() ? { subcategory: row.subcategory.trim() } : {}),
    ...(validDims(dims) ? { dimensionsCm: { w: dims.w, h: dims.h, d: dims.d } } : {}),
    variants: (row.variants ?? []).filter((v) => v && v.code),
    referenceImages: images,
    source3dUrl: src3d && HTTPS_RE.test(src3d) ? src3d : null,
    productLink: link && HTTP_RE.test(link) ? link : null,
    active: row.active !== false,
  };
  return { ok: true, payload, hash: sha256(canonical(payload)), warnings };
}

export const catalogueDir = (file: string): string => dirname(resolve(file));

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
