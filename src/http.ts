// fetch with retry/backoff. The Integration API answers 429 + Retry-After (seconds) when a key exceeds its
// burst limit or daily quota; 5xx are transient. Both are retried, honouring Retry-After when present.

import type { Logger } from "./log.ts";
import { errMsg } from "./log.ts";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class HttpError extends Error {
  status: number;
  body: string;
  url: string;
  constructor(status: number, url: string, body: string, label = "http") {
    super(`${label} ${status} ${stripQuery(url)}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}

/** Retry-After is either delta-seconds or an HTTP date (RFC 9110 §10.2.3). */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const s = header.trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
  const at = Date.parse(s);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export type RetryOptions = {
  sleep: Sleep;
  log: Logger;
  label: string;
  maxAttempts?: number; // total tries, default 5
  retryOn?: number[]; // default 429, 502, 503, 504
  baseDelayMs?: number; // exponential backoff base when no Retry-After, default 1000
  maxDelayMs?: number; // cap per wait, default 60 s
};

export async function fetchWithRetry(
  fetchFn: FetchLike,
  url: string,
  init: RequestInit,
  opts: RetryOptions,
): Promise<Response> {
  const maxAttempts = opts.maxAttempts ?? 5;
  const retryOn = opts.retryOn ?? [429, 502, 503, 504];
  const base = opts.baseDelayMs ?? 1000;
  const cap = opts.maxDelayMs ?? 60_000;
  for (let attempt = 1; ; attempt++) {
    let res: Response | null = null;
    let netErr: unknown = null;
    try {
      res = await fetchFn(url, init);
    } catch (err) {
      netErr = err;
    }
    const retryable = netErr !== null || (res !== null && retryOn.includes(res.status));
    if (!retryable || attempt >= maxAttempts) {
      if (netErr) throw netErr;
      return res as Response;
    }
    const hinted = res ? retryAfterMs(res.headers.get("retry-after")) : null;
    const wait = Math.min(cap, hinted ?? base * 2 ** (attempt - 1));
    opts.log("warn", `${opts.label}.retry`, {
      attempt,
      status: res?.status ?? null,
      error: netErr ? errMsg(netErr) : undefined,
      wait_ms: wait,
      url: stripQuery(url),
    });
    if (res) await res.body?.cancel().catch(() => {});
    await opts.sleep(wait);
  }
}
