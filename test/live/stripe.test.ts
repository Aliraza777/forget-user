// End-to-end against a real Stripe account in test mode. Run with `npm run test:live`
// and STRIPE_SECRET_KEY=sk_test_... in the environment or in .env.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

try {
  process.loadEnvFile(fileURLToPath(new URL("../../.env", import.meta.url)));
} catch {}
const KEY = process.env.STRIPE_SECRET_KEY ?? "";
if (KEY && !KEY.startsWith("sk_test_") && !KEY.startsWith("rk_test_"))
  throw new Error("Live tests only run with a Stripe TEST key (sk_test_ or rk_test_).");

const CLI = fileURLToPath(new URL("../../src/cli.ts", import.meta.url));
const TSX = new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url).href;

/** Minimal Stripe call with nested form params flattened the way Stripe expects. */
async function api<T = Record<string, unknown>>(
  method: string,
  path: string,
  params: Record<string, string | number | boolean> = {},
): Promise<T> {
  const body = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(
    `https://api.stripe.com${path}${method === "GET" && body.size ? `?${body}` : ""}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: method === "GET" ? undefined : body,
    },
  );
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error?.message}`);
  return json;
}

function cli(args: string[]) {
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, STRIPE_SECRET_KEY: KEY, NO_COLOR: "1" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const charge = (customer: string) =>
  api("POST", "/v1/payment_intents", {
    amount: 1000,
    currency: "usd",
    customer,
    payment_method: "pm_card_visa",
    confirm: true,
    "automatic_payment_methods[enabled]": true,
    "automatic_payment_methods[allow_redirects]": "never",
  });

const personal = {
  name: "Ann Test",
  phone: "+15555550100",
  description: "forget-user live test",
  "address[line1]": "1 Test Street",
  "address[city]": "Testville",
  "shipping[name]": "Ann Test",
  "shipping[address][line1]": "1 Test Street",
  "metadata[source]": "forget-user-live-test",
};

describe.skipIf(!KEY)("stripe (live, test mode)", () => {
  const run = Date.now().toString(36);
  const mixed = `Ann.${run}@Example.com`; // what the operator types
  const lower = mixed.toLowerCase();
  const ids: Record<string, string> = {};
  const dir = mkdtempSync(join(tmpdir(), "forget-user-live-"));

  beforeAll(async () => {
    const product = await api<{ id: string }>("POST", "/v1/products", {
      name: `forget-user ${run}`,
    });
    const price = await api<{ id: string }>("POST", "/v1/prices", {
      product: product.id,
      unit_amount: 500,
      currency: "usd",
      "recurring[interval]": "month",
    });
    ids.product = product.id;
    // A: exact email as typed, never charged, on a trial subscription.
    ids.a = (await api<{ id: string }>("POST", "/v1/customers", { email: mixed, ...personal })).id;
    ids.sub = (
      await api<{ id: string }>("POST", "/v1/subscriptions", {
        customer: ids.a,
        "items[0][price]": price.id,
        trial_period_days: 14,
      })
    ).id;
    // B: lowercase email, charged once.
    ids.b = (await api<{ id: string }>("POST", "/v1/customers", { email: lower, ...personal })).id;
    await charge(ids.b);
    // C: lowercase email, never charged.
    ids.c = (await api<{ id: string }>("POST", "/v1/customers", { email: lower })).id;
    // D: someone else entirely; must not be touched.
    ids.d = (
      await api<{ id: string }>("POST", "/v1/customers", { email: `bob.${run}@example.com` })
    ).id;
    // E: another person, charged, for the scrub run.
    ids.eEmail = `eve.${run}@example.com`;
    ids.e = (
      await api<{ id: string }>("POST", "/v1/customers", { email: ids.eEmail, ...personal })
    ).id;
    await charge(ids.e);
  }, 120_000);

  afterAll(async () => {
    for (const id of [ids.b, ids.d, ids.e])
      if (id) await api("DELETE", `/v1/customers/${id}`).catch(() => {});
    if (ids.product)
      await api("POST", `/v1/products/${ids.product}`, { active: false }).catch(() => {});
  });

  it("discover finds both email spellings and plans the right action for each", () => {
    const r = cli(["discover", mixed, "--only", "stripe", "--format", "json"]);
    expect(r.err).toBe("");
    const [stripe] = JSON.parse(r.out);
    const byId = Object.fromEntries(stripe.found.map((f: { id: string }) => [f.id, f]));
    expect(Object.keys(byId).sort()).toEqual([ids.a, ids.b, ids.c].sort());
    expect(byId[ids.a!]).toMatchObject({ action: "delete" });
    expect(byId[ids.a!].warnings).toEqual(["deleting cancels 1 active subscription immediately"]);
    expect(byId[ids.b!]).toMatchObject({ action: "retain" });
    expect(byId[ids.b!].label).toContain("1 successful charge");
    expect(byId[ids.c!]).toMatchObject({
      action: "delete",
      label: `customer ${ids.c} (never charged)`,
    });
  });

  it("delete without --confirm changes nothing", async () => {
    const r = cli(["delete", mixed, "--only", "stripe"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dry run: nothing was changed");
    expect(await api("GET", `/v1/customers/${ids.a}`)).not.toHaveProperty("deleted");
  });

  it("delete --confirm removes uncharged customers, keeps the charged one, and writes a clean receipt", async () => {
    const receiptPath = join(dir, "receipt.json");
    const r = cli(["delete", mixed, "--only", "stripe", "--confirm", "--receipt", receiptPath]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);

    expect(await api("GET", `/v1/customers/${ids.a}`)).toMatchObject({ deleted: true });
    expect(await api("GET", `/v1/customers/${ids.c}`)).toMatchObject({ deleted: true });
    expect(await api("GET", `/v1/subscriptions/${ids.sub}`)).toMatchObject({ status: "canceled" });
    expect(await api("GET", `/v1/customers/${ids.b}`)).toMatchObject({
      email: lower,
      name: "Ann Test",
    });
    expect(await api("GET", `/v1/customers/${ids.d}`)).toMatchObject({
      email: `bob.${run}@example.com`,
    });

    const text = readFileSync(receiptPath, "utf8");
    expect(text.toLowerCase()).not.toContain(lower);
    const receipt = JSON.parse(text);
    expect(receipt.summary).toMatchObject({ deleted: 2, retained: 1, failed: 0 });
    for (const o of receipt.services[0].outcomes)
      if (o.status === "deleted") expect(o.verified).toBe(true);
  });

  it("--stripe-charged scrub clears the personal fields and keeps the customer", async () => {
    const r = cli([
      "delete",
      ids.eEmail!,
      "--only",
      "stripe",
      "--stripe-charged",
      "scrub",
      "--confirm",
      "--no-receipt",
    ]);
    expect(r.err).toBe("");
    expect(r.code).toBe(0);
    const e = await api<Record<string, unknown>>("GET", `/v1/customers/${ids.e}`);
    expect(e).not.toHaveProperty("deleted");
    expect(e).toMatchObject({
      email: null,
      name: null,
      phone: null,
      description: null,
      address: null,
      shipping: null,
      metadata: {},
    });
  });
});
