// Save what CharpstAR made for an article into out/<article>/:
//   links.json        status + viewer/AR/GLB/USDZ links + embed snippet (rewritten on every change)
//   images.json       the image list as the API returned it, plus the local file name of each
//   images/<id>.<ext> every approved image or video, downloaded once (skipped when the file already
//                     has the reported size); primary.<ext> is a copy of the primary image
//   <fileName>        every file a job made (a packshot, a video, an export), under the name the API gave it
//   outputs.json      one entry per job file saved here: the output as the API returned it, plus its jobId
// This is where your system would instead write links into the ERP item and attach the images.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FetchLike, Sleep } from "./http.ts";
import { HttpError, fetchWithRetry } from "./http.ts";
import { EXT } from "./image.ts";
import type { Logger } from "./log.ts";
import type { Asset, AssetImage, Job, JobOutput } from "./platform.ts";

export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
const ARTICLE_OK = /^[A-Za-z0-9][A-Za-z0-9._\-]{0,63}$/;
/** The API's file names: letters, digits, "-", "_" and ".", up to 200 characters. A leading "." is refused. */
const FILE_NAME_OK = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,199}$/;
/** This client's own files in out/<article>/: a job file may not take their place. */
const OWN_FILES = new Set(["links.json", "images.json", "outputs.json"]);

export type DownloadResult = { article: string; dir: string; downloaded: string[]; skipped: string[]; failed: string[] };

export type DownloadDeps = { fetch: FetchLike; sleep: Sleep; log: Logger; dryRun?: boolean };

export async function saveAsset(asset: Asset, outDir: string, deps: DownloadDeps): Promise<DownloadResult> {
  const article = asset.articleId;
  if (!ARTICLE_OK.test(article)) throw new Error(`refusing unsafe article id "${article}"`);
  const dir = join(outDir, article);
  const imgDir = join(dir, "images");
  const res: DownloadResult = { article, dir, downloaded: [], skipped: [], failed: [] };
  const approved = (asset.images ?? []).filter((i) => i.approved !== false);

  if (deps.dryRun) {
    for (const img of approved) res.skipped.push(`${img.id} (dry-run: would download ${img.bytes ?? "?"} bytes from ${img.url})`);
    deps.log("info", "download.dry_run", { article, dir, images: approved.length, status: asset.status });
    return res;
  }

  mkdirSync(imgDir, { recursive: true });
  writeJson(join(dir, "links.json"), {
    articleId: article,
    name: asset.name ?? null,
    status: asset.status,
    statusDetail: asset.statusDetail ?? null,
    deliveryDate: asset.deliveryDate ?? null,
    updatedAt: asset.updatedAt ?? null,
    viewerUrl: asset.viewerUrl ?? null,
    arUrl: asset.arUrl ?? null,
    glbUrl: asset.glbUrl ?? null,
    usdzUrl: asset.usdzReady ? (asset.usdzUrl ?? null) : null,
    thumbnailUrl: asset.thumbnailUrl ?? null,
    embedSnippet: asset.embed?.snippet ?? null,
    variations: asset.variations ?? [],
    savedAt: new Date().toISOString(),
  });

  const index: Array<AssetImage & { file: string | null }> = [];
  for (const img of approved) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(img.id)) {
      res.failed.push(`${img.id}: unsafe id`);
      continue;
    }
    const file = `${img.id}.${extFor(img)}`;
    const path = join(imgDir, file);
    index.push({ ...img, file: `images/${file}` });
    if (existsSync(path) && (!img.bytes || statSync(path).size === img.bytes)) {
      res.skipped.push(img.id);
    } else {
      try {
        await downloadTo(img.url, path, deps);
        res.downloaded.push(img.id);
      } catch (err) {
        res.failed.push(`${img.id}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }
    if (img.primary) copyFileSync(path, join(dir, `primary.${extFor(img)}`));
  }
  writeJson(join(dir, "images.json"), index);
  deps.log(res.failed.length ? "warn" : "info", "download.saved", {
    article,
    status: asset.status,
    downloaded: res.downloaded.length,
    skipped: res.skipped.length,
    failed: res.failed,
  });
  return res;
}

/**
 * Save the files of a finished job into out/<article>/, each under its `fileName`.
 * A new picture of the same view keeps its file name and gets a new output id, so the id recorded in
 * outputs.json decides whether a file is already here. A repeat of the same job downloads nothing.
 */
export async function saveJobOutputs(job: Job, outDir: string, deps: DownloadDeps): Promise<DownloadResult> {
  const article = job.articleId;
  if (!ARTICLE_OK.test(article)) throw new Error(`refusing unsafe article id "${article}"`);
  const dir = join(outDir, article);
  const res: DownloadResult = { article, dir, downloaded: [], skipped: [], failed: [] };

  if (deps.dryRun) {
    for (const o of job.outputs) res.skipped.push(`${o.fileName} (dry-run: would download ${o.bytes ?? "?"} bytes from ${o.url})`);
    deps.log("info", "download.dry_run", { article, dir, job: job.id, files: job.outputs.length });
    return res;
  }

  mkdirSync(dir, { recursive: true });
  const indexFile = join(dir, "outputs.json");
  type Saved = JobOutput & { jobId: string; savedAt: string };
  const index: Saved[] = existsSync(indexFile) ? (JSON.parse(readFileSync(indexFile, "utf8")) as Saved[]) : [];
  for (const o of job.outputs) {
    if (!FILE_NAME_OK.test(o.fileName) || OWN_FILES.has(o.fileName)) {
      res.failed.push(`${o.fileName}: unsafe file name`);
      continue;
    }
    const path = join(dir, o.fileName);
    const at = index.findIndex((e) => e.fileName === o.fileName);
    if (at !== -1 && index[at].id === o.id && existsSync(path)) {
      res.skipped.push(o.fileName);
      continue;
    }
    try {
      await downloadTo(o.url, path, deps);
      res.downloaded.push(o.fileName);
    } catch (err) {
      res.failed.push(`${o.fileName}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const entry: Saved = { ...o, jobId: job.id, savedAt: new Date().toISOString() };
    if (at === -1) index.push(entry);
    else index[at] = entry;
  }
  writeJson(indexFile, index);
  deps.log(res.failed.length ? "warn" : "info", "download.job_saved", {
    article,
    job: job.id,
    downloaded: res.downloaded,
    skipped: res.skipped.length,
    failed: res.failed,
  });
  return res;
}

async function downloadTo(url: string, path: string, deps: DownloadDeps): Promise<void> {
  const u = new URL(url);
  const local = u.hostname === "127.0.0.1" || u.hostname === "localhost";
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error(`not https: ${u.origin}`);
  const res = await fetchWithRetry(deps.fetch, url, { redirect: "follow" }, { sleep: deps.sleep, log: deps.log, label: "download" });
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ""), "download");
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`too large (${declared} bytes)`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) throw new Error(`too large (${bytes.length} bytes)`);
  const tmp = `${path}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, path); // never leave a half-written image under the final name
}

function extFor(img: AssetImage): string {
  const m = new URL(img.url).pathname.match(/\.(jpe?g|png|webp|avif|gif|tiff?|mp4|webm|mov)$/i);
  if (m) return m[1].toLowerCase().replace("jpeg", "jpg");
  return img.type === "video" ? "mp4" : EXT["image/jpeg"];
}

function writeJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}
