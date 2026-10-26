export type Fetch = typeof fetch;

export class HttpError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Query = Record<string, string | number | string[] | undefined>;

export interface RequestOptions {
  query?: Query;
  json?: unknown;
  /** Sent as application/x-www-form-urlencoded (Stripe). */
  form?: Record<string, string>;
  /** Statuses returned to the caller instead of thrown, e.g. 404 for "not found". */
  allow?: number[];
}

export interface Response<T> {
  status: number;
  body: T;
}

export interface ClientOptions {
  service: string;
  base: string;
  headers: Record<string, string>;
  fetch?: Fetch;
  timeoutMs?: number;
  retries?: number;
  /** Wait before a retry; injectable so tests don't sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface Client {
  request<T>(method: string, path: string, opts?: RequestOptions): Promise<Response<T>>;
}

const RETRY = new Set([429, 500, 502, 503, 504]);

export function createClient(o: ClientOptions): Client {
  const doFetch = o.fetch ?? globalThis.fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const retries = o.retries ?? 3;

  return {
    async request<T>(method: string, path: string, opts: RequestOptions = {}) {
      const url = new URL(path, o.base);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v === undefined) continue;
        for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
      }
      const headers: Record<string, string> = { Accept: "application/json", ...o.headers };
      let body: string | undefined;
      if (opts.json !== undefined) {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(opts.json);
      } else if (opts.form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded";
        body = new URLSearchParams(opts.form).toString();
      }

      for (let attempt = 0; ; attempt++) {
        let res: globalThis.Response;
        try {
          res = await doFetch(url, {
            method,
            headers,
            body,
            signal: AbortSignal.timeout(o.timeoutMs ?? 20_000),
          });
        } catch (e) {
          if (attempt < retries) {
            await sleep(backoff(attempt));
            continue;
          }
          throw new HttpError(o.service, 0, `${o.service}: ${method} ${url.pathname} failed: ${e}`);
        }
        if (RETRY.has(res.status) && attempt < retries) {
          const after = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoff(attempt));
          continue;
        }
        const text = await res.text();
        const parsed = text ? safeJson(text) : null;
        if (res.ok || opts.allow?.includes(res.status)) {
          return { status: res.status, body: parsed as T };
        }
        throw new HttpError(
          o.service,
          res.status,
          `${o.service}: ${method} ${url.pathname} returned ${res.status}: ${errorText(parsed, text)}`,
        );
      }
    },
  };
}

const backoff = (attempt: number) => 500 * 2 ** attempt;

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Pull the vendor's own message out of the common error shapes, kept short. */
function errorText(parsed: unknown, text: string): string {
  const p = parsed as Record<string, unknown> | null;
  const nested = p?.error as Record<string, unknown> | string | undefined;
  const msg =
    (typeof nested === "object" ? nested?.message : nested) ??
    p?.message ??
    p?.detail ??
    (Array.isArray(p?.errors) ? (p.errors[0] as Record<string, unknown>)?.message : undefined) ??
    text;
  return String(msg).slice(0, 300);
}
