import { describe, expect, it } from "vitest";
import { createClient, HttpError } from "../src/http.js";
import { fakeFetch, noSleep } from "./fake.js";

const base = {
  service: "svc",
  base: "https://api.example.com",
  headers: { Authorization: "Bearer k" },
};

describe("http client", () => {
  it("repeats array query params and skips undefined ones", async () => {
    const f = fakeFetch({ "GET /x": () => ({ body: [] }) });
    await createClient({ ...base, fetch: f.fetch }).request("GET", "/x", {
      query: { a: ["1", "2"], b: undefined, c: 3 },
    });
    expect(f.calls[0]!.url.search).toBe("?a=1&a=2&c=3");
  });

  it("sends form bodies url-encoded and JSON bodies as JSON", async () => {
    const f = fakeFetch({ "POST /x": () => ({ body: {} }) });
    const api = createClient({ ...base, fetch: f.fetch });
    await api.request("POST", "/x", { form: { name: "", email: "a@b.c" } });
    await api.request("POST", "/x", { json: { ids: ["1"] } });
    expect(f.calls[0]!.body).toBe("name=&email=a%40b.c");
    expect(f.calls[0]!.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(f.calls[1]!.body).toBe('{"ids":["1"]}');
  });

  it("retries 429 using Retry-After, then succeeds", async () => {
    let n = 0;
    const waits: number[] = [];
    const f = fakeFetch({
      "GET /x": () =>
        ++n < 3 ? { status: 429, headers: { "retry-after": "2" } } : { body: { ok: true } },
    });
    const r = await createClient({
      ...base,
      fetch: f.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
    }).request("GET", "/x");
    expect(r.body).toEqual({ ok: true });
    expect(waits).toEqual([2000, 2000]);
  });

  it("returns allowed statuses and throws the vendor's message for others", async () => {
    const f = fakeFetch({
      "GET /missing": () => ({ status: 404, body: { message: "Not found" } }),
      "GET /denied": () => ({ status: 401, body: { error: { message: "Invalid API Key" } } }),
    });
    const api = createClient({ ...base, fetch: f.fetch, sleep: noSleep });
    expect((await api.request("GET", "/missing", { allow: [404] })).status).toBe(404);
    const err = await api.request("GET", "/denied").catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("svc: GET /denied returned 401: Invalid API Key");
    expect(err.message).not.toContain("Bearer");
  });

  it("gives up after the retry limit", async () => {
    const f = fakeFetch({ "GET /x": () => ({ status: 503, body: { message: "down" } }) });
    const err = await createClient({ ...base, fetch: f.fetch, sleep: noSleep, retries: 2 })
      .request("GET", "/x")
      .catch((e) => e);
    expect(f.calls).toHaveLength(3);
    expect(err.status).toBe(503);
  });
});
