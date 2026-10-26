import { describe, expect, it } from "vitest";
import { buildReceipt, canonical, verifyReceipt } from "../src/receipt.js";
import { hasProblems } from "../src/report.js";
import { discover, execute } from "../src/run.js";
import type { Adapter, Found } from "../src/types.js";

/** An in-memory service whose records disappear when deleted (unless it's broken). */
function memory(id: "stripe" | "clerk", records: Found[], o: { ignoresDeletes?: boolean } = {}) {
  let left = [...records];
  const adapter: Adapter = {
    id,
    name: id,
    async discover() {
      return left;
    },
    async apply(f) {
      if (f.id === "boom") throw new Error("server said no");
      if (f.action === "retain") return { status: "retained" };
      if (!o.ignoresDeletes) left = left.filter((r) => r.id !== f.id);
      return { status: f.action === "scrub" ? "scrubbed" : "deleted" };
    },
  };
  return adapter;
}

const rec = (
  service: "stripe" | "clerk",
  id: string,
  action: Found["action"] = "delete",
): Found => ({
  service,
  id,
  label: `record ${id}`,
  action,
});
const subject = { email: "Ann@Example.com" };

describe("discover / execute", () => {
  it("keeps going when one service fails", async () => {
    const broken: Adapter = {
      id: "clerk",
      name: "Clerk",
      discover: async () => {
        throw new Error("clerk: GET /v1/users returned 401: Unauthorized");
      },
      apply: async () => ({ status: "deleted" }),
    };
    const results = await discover([memory("stripe", [rec("stripe", "a")]), broken], subject);
    expect(results[0]!.found).toHaveLength(1);
    expect(results[1]!.error).toContain("401");
  });

  it("checks each delete by looking the subject up again", async () => {
    const ok = memory("stripe", [rec("stripe", "a"), rec("stripe", "b", "retain")]);
    const liar = memory("clerk", [rec("clerk", "c")], { ignoresDeletes: true });
    const results = await discover([ok, liar], subject);
    const done = await execute([ok, liar], results, subject);
    expect(done[0]!.outcomes.map((o) => [o.id, o.status, o.verified])).toEqual([
      ["a", "deleted", true],
      ["b", "retained", undefined],
    ]);
    expect(done[1]!.outcomes[0]).toMatchObject({ status: "deleted", verified: false });
    expect(hasProblems(done)).toBe(true);
  });

  it("records a failed action without stopping the others", async () => {
    const svc = memory("stripe", [rec("stripe", "boom"), rec("stripe", "a")]);
    const done = await execute([svc], await discover([svc], subject), subject);
    expect(done[0]!.outcomes.map((o) => o.status)).toEqual(["failed", "deleted"]);
    expect(done[0]!.outcomes[0]!.error).toBe("server said no");
    expect(hasProblems(done)).toBe(true);
  });
});

describe("receipt", () => {
  const run = async () => {
    const svc = memory("stripe", [rec("stripe", "a"), rec("stripe", "b", "retain")]);
    return execute([svc], await discover([svc], subject), subject);
  };
  const when = new Date("2026-10-26T12:00:00Z");

  it("names the subject only by hash and counts outcomes", async () => {
    const r = buildReceipt({ ...subject, userId: "u_1" }, await run(), undefined, when);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/ann@example\.com|u_1/i);
    expect(r.subject.hash).toBe("sha256");
    expect(r.subject.email).toMatch(/^[0-9a-f]{64}$/);
    expect(r.summary).toEqual({ deleted: 1, scrubbed: 0, retained: 1, pending: 0, failed: 0 });
    expect(r.signature).toBeUndefined();
  });

  it("removes the email and user id from vendor error messages", () => {
    const r = buildReceipt({ email: "Ann@Example.com", userId: "u_1" }, [
      {
        service: "resend",
        name: "Resend",
        manual: [],
        error: "resend: GET /contacts/ann%40example.com returned 500: oops for ANN@example.com",
        outcomes: [
          {
            service: "resend",
            id: "c1",
            label: "contact c1",
            action: "delete",
            status: "failed",
            error: "user u_1 locked",
          },
        ],
      },
    ]);
    expect(r.services[0]!.error).toBe(
      "resend: GET /contacts/[subject] returned 500: oops for [subject]",
    );
    expect(r.services[0]!.outcomes[0]!.error).toBe("user [subject] locked");
  });

  it("signs with a key; the signature survives re-saving but not edits", async () => {
    const r = buildReceipt(subject, await run(), "secret", when);
    expect(r.subject.hash).toBe("hmac-sha256");
    const resaved = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(r).reverse())));
    expect(verifyReceipt(resaved, "secret")).toEqual({ ok: true });
    expect(verifyReceipt(r, "secret", " ann@EXAMPLE.com ")).toEqual({ ok: true });
    expect(verifyReceipt(r, "secret", "bob@example.com")).toEqual({
      ok: false,
      reason: "mismatch",
    });
    expect(verifyReceipt(r, "other-key")).toEqual({ ok: false, reason: "mismatch" });
    const edited = structuredClone(r);
    edited.summary.failed = 0;
    edited.services[0]!.outcomes[1]!.status = "deleted";
    expect(verifyReceipt(edited, "secret")).toEqual({ ok: false, reason: "mismatch" });
  });

  it("rejects unsigned and foreign files", async () => {
    expect(verifyReceipt(buildReceipt(subject, await run(), undefined), "k")).toEqual({
      ok: false,
      reason: "unsigned",
    });
    expect(verifyReceipt({ hello: 1 }, "k")).toEqual({ ok: false, reason: "invalid" });
    expect(verifyReceipt(null, "k")).toEqual({ ok: false, reason: "invalid" });
  });

  it("canonical JSON sorts keys at every level", () => {
    expect(canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":[2,{"e":0,"f":1}]},"b":1}',
    );
  });
});
