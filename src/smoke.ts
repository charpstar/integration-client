// End-to-end check of a key against a running platform, without touching state.json or out/:
//   1. GET  /api/v1/me
//   2. POST /api/v1/products        every catalogue row (no "only what changed": the platform's own
//                                    idempotency answers "unchanged" for repeats)
//   3. GET  /api/v1/assets/{article} for each article the platform accepted
//   4. GET  /api/v1/assets?since=    once, from just before the push, following nextCursor
// Returns a JSON-friendly summary; `ok` is false when any step failed.

import type { CatalogueRow } from "./catalogue.ts";
import { toPayload } from "./catalogue.ts";
import { errMsg } from "./log.ts";
import type { Asset, Me, PlatformClient, UpsertResult } from "./platform.ts";
import { isAccepted } from "./platform.ts";

export type SmokeSummary = {
  ok: boolean;
  api: string;
  me: Me | null;
  push: {
    sent: number;
    invalid: string[];
    warnings: Record<string, string[]>;
    results: Array<Pick<UpsertResult, "articleId" | "result" | "status" | "statusDetail" | "httpStatus" | "pendingChanges" | "warnings"> & { error?: string }>;
  };
  assets: Array<{ articleId: string; found: boolean; status?: string; glbUrl?: string | null; viewerUrl?: string | null; images?: number; error?: string }>;
  poll: { since: string; pages: number; changed: number; articles: string[]; pushedSeen: string[]; error?: string } | null;
  errors: string[];
};

const OVERLAP_MS = 2 * 60_000;

export async function runSmoke(platform: PlatformClient, rows: CatalogueRow[], api: string): Promise<SmokeSummary> {
  const s: SmokeSummary = { ok: false, api, me: null, push: { sent: 0, invalid: [], warnings: {}, results: [] }, assets: [], poll: null, errors: [] };
  try {
    s.me = await platform.me();
  } catch (err) {
    s.errors.push(`me: ${errMsg(err)}`);
    return s;
  }
  // Use the server's clock (Date header of /me) for the poll, minus the usual overlap.
  const since = new Date(Date.parse(platform.lastServerDate ?? new Date().toISOString()) - OVERLAP_MS).toISOString();

  const payloads = [];
  for (const row of rows) {
    const m = toPayload(row);
    if (!m.ok) {
      s.push.invalid.push(`${m.article}: ${m.reason}`);
      continue;
    }
    if (m.warnings.length) s.push.warnings[m.payload.articleId] = m.warnings;
    payloads.push(m.payload);
  }
  let accepted: string[] = [];
  try {
    const results = payloads.length ? await platform.upsertProducts(payloads) : [];
    s.push.sent = payloads.length;
    s.push.results = results.map((r) => ({
      articleId: r.articleId,
      result: r.result,
      status: r.status,
      statusDetail: r.statusDetail,
      httpStatus: r.httpStatus,
      pendingChanges: r.pendingChanges,
      warnings: r.warnings,
      ...(r.error ? { error: `${r.error.code}: ${r.error.message}` } : {}),
    }));
    accepted = results.filter(isAccepted).map((r) => r.articleId);
    for (const r of results) if (!isAccepted(r)) s.errors.push(`push ${r.articleId}: ${r.error?.code ?? r.result}`);
  } catch (err) {
    s.errors.push(`push: ${errMsg(err)}`);
  }

  for (const article of accepted) {
    try {
      const a: Asset | null = await platform.getAsset(article);
      if (!a) {
        s.assets.push({ articleId: article, found: false });
        s.errors.push(`asset ${article}: 404 right after an accepted push`);
      } else s.assets.push({ articleId: a.articleId, found: true, status: a.status, glbUrl: a.glbUrl ?? null, viewerUrl: a.viewerUrl ?? null, images: a.images?.length ?? 0 });
    } catch (err) {
      s.assets.push({ articleId: article, found: false, error: errMsg(err) });
      s.errors.push(`asset ${article}: ${errMsg(err)}`);
    }
  }

  try {
    const page = await platform.listAssetsSince(since);
    const articles = page.assets.map((a) => a.articleId);
    s.poll = { since, pages: page.pages, changed: articles.length, articles, pushedSeen: accepted.filter((a) => articles.includes(a)) };
  } catch (err) {
    s.poll = { since, pages: 0, changed: 0, articles: [], pushedSeen: [], error: errMsg(err) };
    s.errors.push(`poll: ${errMsg(err)}`);
  }
  s.ok = s.errors.length === 0 && s.push.invalid.length === 0;
  return s;
}
