import { describe, expect, it } from "vitest";
import { clerk } from "../src/adapters/clerk.js";
import { adaptersFromEnv } from "../src/adapters/index.js";
import { loops } from "../src/adapters/loops.js";
import { posthog } from "../src/adapters/posthog.js";
import { resend } from "../src/adapters/resend.js";
import { stripe } from "../src/adapters/stripe.js";
import { fakeFetch, noSleep } from "./fake.js";

const list = <T>(data: T[]) => ({ body: { object: "list", data, has_more: false } });

describe("stripe", () => {
  const world = (charges: Record<string, string[]>, subs: Record<string, string[]> = {}) =>
    fakeFetch({
      "GET /v1/customers": (u) =>
        u.searchParams.get("email") === "Ann@Example.com"
          ? list([{ id: "cus_A", email: "Ann@Example.com" }])
          : list([
              { id: "cus_A", email: "ann@example.com" },
              { id: "cus_B", email: "ann@example.com" },
            ]),
      "GET /v1/charges": (u) =>
        list((charges[u.searchParams.get("customer")!] ?? []).map((status) => ({ status }))),
      "GET /v1/subscriptions": (u) =>
        list((subs[u.searchParams.get("customer")!] ?? []).map((status) => ({ status }))),
      "DELETE /v1/customers/cus_A": () => ({ body: { id: "cus_A", deleted: true } }),
      "POST /v1/customers/cus_B": () => ({ body: { id: "cus_B" } }),
    });

  it("looks the email up as given and lowercased, without duplicates", async () => {
    const f = world({});
    const found = await stripe("sk", { charged: "retain", fetch: f.fetch }).discover({
      email: "Ann@Example.com",
    });
    expect(found.map((x) => x.id)).toEqual(["cus_A", "cus_B"]);
    const emails = f.calls
      .filter((c) => c.url.pathname === "/v1/customers")
      .map((c) => c.url.searchParams.get("email"));
    expect(emails).toEqual(["Ann@Example.com", "ann@example.com"]);
    expect(f.calls[0]!.headers.Authorization).toBe("Bearer sk");
  });

  it("deletes never-charged customers and retains charged ones by default", async () => {
    const f = world(
      { cus_B: ["failed", "succeeded", "succeeded"] },
      { cus_A: ["active", "canceled"] },
    );
    const [a, b] = await stripe("sk", { charged: "retain", fetch: f.fetch }).discover({
      email: "ann@example.com",
    });
    expect(a).toMatchObject({ action: "delete", label: "customer cus_A (never charged)" });
    expect(a!.warnings).toEqual(["deleting cancels 1 active subscription immediately"]);
    expect(b).toMatchObject({ action: "retain", label: "customer cus_B (2 successful charges)" });
    expect(b!.reason).toContain("tax and fraud");
  });

  it("scrubs charged customers by clearing personal fields", async () => {
    const f = world({ cus_B: ["succeeded"] });
    const s = stripe("sk", { charged: "scrub", fetch: f.fetch });
    const [a, b] = await s.discover({ email: "ann@example.com" });
    expect(await s.apply(a!)).toEqual({ status: "deleted" });
    expect(await s.apply(b!)).toEqual({ status: "scrubbed" });
    const post = f.calls.find((c) => c.method === "POST")!;
    expect(Object.fromEntries(new URLSearchParams(post.body))).toEqual({
      name: "",
      email: "",
      phone: "",
      description: "",
      address: "",
      shipping: "",
      metadata: "",
    });
  });

  it("treats a customer that's already gone as deleted", async () => {
    const f = fakeFetch({
      "DELETE /v1/customers/cus_X": () => ({
        status: 404,
        body: { error: { message: "No such customer" } },
      }),
    });
    const r = await stripe("sk", { charged: "retain", fetch: f.fetch }).apply({
      service: "stripe",
      id: "cus_X",
      label: "",
      action: "delete",
    });
    expect(r).toEqual({ status: "deleted", note: "already gone" });
  });
});

describe("posthog", () => {
  it("finds persons by email and distinct id, then bulk-deletes with events and recordings", async () => {
    const f = fakeFetch({
      "GET /api/projects/42/persons/": (u) =>
        u.searchParams.get("distinct_id") === "u_1"
          ? {
              body: {
                results: [
                  { id: "p1", distinct_ids: ["u_1", "anon"] },
                  { id: "p2", distinct_ids: ["u_1"] },
                ],
              },
            }
          : { body: { results: [{ id: "p1", distinct_ids: ["u_1", "anon"] }] } },
      "POST /api/projects/42/persons/bulk_delete/": () => ({
        status: 202,
        body: { persons_found: 1 },
      }),
    });
    const p = posthog("phx", { projectId: "42", host: "https://eu.posthog.com", fetch: f.fetch });
    const found = await p.discover({ email: "ann@example.com", userId: "u_1" });
    expect(found.map((x) => x.id)).toEqual(["p1", "p2"]);
    expect(found[0]!.label).toBe("person p1 (2 distinct ids)");
    expect((await p.apply(found[0]!)).status).toBe("deleted");
    const del = f.calls.find((c) => c.method === "POST")!;
    expect(del.url.origin).toBe("https://eu.posthog.com");
    expect(JSON.parse(del.body!)).toEqual({
      ids: ["p1"],
      delete_events: true,
      delete_recordings: true,
    });
  });

  it("fails when PostHog reports a deletion error", async () => {
    const f = fakeFetch({
      "POST /api/projects/42/persons/bulk_delete/": () => ({
        status: 202,
        body: { deletion_errors: [{ person_uuid: "p1" }] },
      }),
    });
    const p = posthog("phx", { projectId: "42", host: "https://us.posthog.com", fetch: f.fetch });
    await expect(
      p.apply({ service: "posthog", id: "p1", label: "", action: "delete" }),
    ).rejects.toThrow("could not delete person p1");
  });
});

describe("clerk", () => {
  it("searches every email variant in one call and deletes by user id", async () => {
    const f = fakeFetch({
      "GET /v1/users": () => ({ body: [{ id: "user_1" }] }),
      "DELETE /v1/users/user_1": () => ({ body: { id: "user_1", deleted: true } }),
    });
    const c = clerk("sk_test", { fetch: f.fetch });
    const [u] = await c.discover({ email: "Ann@Example.com" });
    expect(f.calls[0]!.url.searchParams.getAll("email_address")).toEqual([
      "Ann@Example.com",
      "ann@example.com",
    ]);
    expect(await c.apply(u!)).toEqual({ status: "deleted" });
  });
});

describe("resend", () => {
  it("treats 404 as nothing found and deletes found contacts by id", async () => {
    const f = fakeFetch({
      "GET /contacts/Ann%40Example.com": () => ({
        status: 404,
        body: { message: "Contact not found" },
      }),
      "GET /contacts/ann%40example.com": () => ({
        body: { object: "contact", id: "c1", email: "ann@example.com" },
      }),
      "DELETE /contacts/c1": () => ({ body: { object: "contact", contact: "c1", deleted: true } }),
    });
    const r = resend("re_x", { fetch: f.fetch, sleep: noSleep });
    const found = await r.discover({ email: "Ann@Example.com" });
    expect(found).toEqual([{ service: "resend", id: "c1", label: "contact c1", action: "delete" }]);
    expect(await r.apply(found[0]!)).toEqual({ status: "deleted" });
    expect(r.manual?.[0]).toContain("Logs of emails already sent");
  });
});

describe("loops", () => {
  it("finds contacts by email and userId and deletes by the contact's email", async () => {
    const f = fakeFetch({
      "GET /api/v1/contacts/find": (u) =>
        u.searchParams.get("userId") === "u_1"
          ? { body: [{ id: "lc2", email: "old@example.com" }] }
          : { body: [] },
      "POST /api/v1/contacts/delete": () => ({
        body: { success: true, message: "Contact deleted." },
      }),
    });
    const l = loops("lk", { fetch: f.fetch });
    const [c] = await l.discover({ email: "ann@example.com", userId: "u_1" });
    expect(c).toMatchObject({ id: "lc2", handle: "old@example.com" });
    await l.apply(c!);
    expect(JSON.parse(f.calls.at(-1)!.body!)).toEqual({ email: "old@example.com" });
  });
});

describe("adaptersFromEnv", () => {
  const opts = { stripeCharged: "retain" as const };

  it("uses only fully configured services and reports half-configured ones", () => {
    const r = adaptersFromEnv(
      { STRIPE_SECRET_KEY: "sk", POSTHOG_PERSONAL_API_KEY: "phx", RESEND_API_KEY: "re" },
      opts,
    );
    expect(r.adapters.map((a) => a.id)).toEqual(["stripe", "resend"]);
    expect(r.incomplete).toEqual([{ id: "posthog", missing: ["POSTHOG_PROJECT_ID"] }]);
  });

  it("with --only, reports a requested service that has no keys", () => {
    const r = adaptersFromEnv(
      { STRIPE_SECRET_KEY: "sk", CLERK_SECRET_KEY: "c" },
      {
        ...opts,
        only: ["clerk", "loops"],
      },
    );
    expect(r.adapters.map((a) => a.id)).toEqual(["clerk"]);
    expect(r.incomplete).toEqual([{ id: "loops", missing: ["LOOPS_API_KEY"] }]);
  });
});
