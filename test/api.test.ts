import { describe, expect, it } from "vitest";
import { forgetUser } from "../src/index.js";
import type { Adapter, Found } from "../src/types.js";

function memory(records: Found[], o: { failDiscover?: boolean } = {}): Adapter {
  let left = [...records];
  return {
    id: "stripe",
    name: "Stripe",
    async discover() {
      if (o.failDiscover) throw new Error("401 Unauthorized");
      return left;
    },
    async apply(f) {
      left = left.filter((r) => r.id !== f.id);
      return { status: "deleted" };
    },
  };
}

const rec: Found = { service: "stripe", id: "cus_1", label: "customer cus_1", action: "delete" };
const subject = { email: "ann@example.com" };

describe("forgetUser", () => {
  it("is a dry run unless confirm is set", async () => {
    const svc = memory([rec]);
    const r = await forgetUser(subject, { adapters: [svc] });
    expect(r).toMatchObject({ done: false, reason: "dry-run" });
    expect(await svc.discover(subject)).toHaveLength(1);
  });

  it("deletes, verifies and returns a signed receipt with confirm", async () => {
    const r = await forgetUser(subject, {
      adapters: [memory([rec])],
      confirm: true,
      receiptKey: "k",
    });
    if (!r.done) throw new Error("expected done");
    expect(r.ok).toBe(true);
    expect(r.executed[0]!.outcomes[0]).toMatchObject({ status: "deleted", verified: true });
    expect(r.receipt.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes nothing when a service can't be checked", async () => {
    const ok = memory([rec]);
    const r = await forgetUser(subject, {
      adapters: [ok, memory([], { failDiscover: true })],
      confirm: true,
    });
    expect(r).toMatchObject({ done: false, reason: "service-error" });
    expect(await ok.discover(subject)).toHaveLength(1);
  });

  it("reads services from env and reports incomplete setup", async () => {
    await expect(forgetUser(subject, { env: {} })).rejects.toThrow("no services configured");
    await expect(forgetUser(subject, { env: { POSTHOG_PERSONAL_API_KEY: "x" } })).rejects.toThrow(
      "posthog: set POSTHOG_PROJECT_ID",
    );
  });
});
