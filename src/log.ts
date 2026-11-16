// Structured log lines: one JSON object per line on stdout.
// Secrets never reach the log: keys and tokens are masked to their prefix.

export type Level = "debug" | "info" | "warn" | "error";
export type Logger = (level: Level, msg: string, fields?: Record<string, unknown>) => void;

const SECRET_PATTERNS: RegExp[] = [
  /\b(cs_live_[A-Za-z0-9]{4})[A-Za-z0-9_-]+/g, // platform API key -> keep "cs_live_Ab3d"
  /\b(whsec_[A-Za-z0-9]{2})[A-Za-z0-9_-]+/g, // webhook secret
  /\b(Bearer )[A-Za-z0-9._~+/=-]{8,}/gi, // any bearer token
  /\b(client_secret=)[^&\s"]+/gi, // token request body
  /\b(eyJ[A-Za-z0-9_-]{4})[A-Za-z0-9._-]{20,}/g, // JWT access tokens
];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "$1***");
  return out;
}

export function createLogger(
  sink: (line: string) => void = (line) => process.stdout.write(line + "\n"),
  minLevel: Level = (process.env.LOG_LEVEL as Level) || "info",
): Logger {
  const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  return (level, msg, fields) => {
    if (order[level] < order[minLevel]) return;
    const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
    sink(redact(line));
  };
}

export function errMsg(err: unknown): string {
  return redact(err instanceof Error ? err.message : String(err));
}

export const silentLogger: Logger = () => {};
