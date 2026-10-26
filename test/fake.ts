import type { Fetch } from "../src/http.js";

export interface Call {
  method: string;
  url: URL;
  body?: string;
  headers: Record<string, string>;
}

type Reply = { status?: number; body?: unknown; headers?: Record<string, string> };
type Handler = (url: URL, body: string | undefined) => Reply | undefined;

/** A fetch that answers from a route table keyed by "METHOD /path" and records every call. */
export function fakeFetch(routes: Record<string, Handler>) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : undefined;
    calls.push({ method, url, body, headers: { ...(init?.headers as Record<string, string>) } });
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler)
      return new Response(
        JSON.stringify({ error: { message: `no route ${method} ${url.pathname}` } }),
        {
          status: 418,
        },
      );
    const r = handler(url, body) ?? {};
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: r.headers,
    });
  }) as Fetch;
  return { fetch, calls };
}

export const noSleep = async () => {};
