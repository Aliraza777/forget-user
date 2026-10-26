import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildReceipt } from "../src/receipt.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url).href;
const KEYS = [
  "STRIPE_SECRET_KEY",
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_PROJECT_ID",
  "CLERK_SECRET_KEY",
  "RESEND_API_KEY",
  "LOOPS_API_KEY",
  "FORGET_USER_RECEIPT_KEY",
];

function cli(args: string[], env: Record<string, string> = {}) {
  const clean = Object.fromEntries(KEYS.map((k) => [k, undefined]));
  const r = spawnSync(process.execPath, ["--import", TSX, CLI, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...clean, NO_COLOR: "1", FORCE_COLOR: "0", ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

describe("cli", () => {
  it("prints the version from package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(cli(["--version"]).out.trim()).toBe(pkg.version);
  });

  it("explains which keys to set when no service is configured", () => {
    const r = cli(["discover", "ann@example.com"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("No services configured");
    expect(r.err).toContain("STRIPE_SECRET_KEY");
    expect(r.err).toContain("POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID");
  });

  it("names the missing variable of a half-configured service", () => {
    const r = cli(["delete", "ann@example.com"], { POSTHOG_PERSONAL_API_KEY: "phx" });
    expect(r.code).toBe(2);
    expect(r.err).toContain("posthog: set POSTHOG_PROJECT_ID");
  });

  it("rejects bad emails and unknown services", () => {
    expect(cli(["discover", "not-an-email"]).err).toContain("doesn't look like an email");
    expect(cli(["discover", "a@b.co", "--only", "stripe,mailchimp"]).err).toContain(
      "Unknown service: mailchimp",
    );
  });

  it("verifies a signed receipt and catches edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "forget-user-"));
    const file = join(dir, "r.json");
    const receipt = buildReceipt({ email: "ann@example.com" }, [], "k1");
    writeFileSync(file, JSON.stringify(receipt));

    const ok = cli(["verify-receipt", file, "--email", "ann@example.com"], {
      FORGET_USER_RECEIPT_KEY: "k1",
    });
    expect(ok.code).toBe(0);
    expect(ok.out).toContain("Signature valid and matches the email");

    expect(cli(["verify-receipt", file], { FORGET_USER_RECEIPT_KEY: "k2" }).code).toBe(1);
    expect(cli(["verify-receipt", file]).err).toContain("Set FORGET_USER_RECEIPT_KEY");

    writeFileSync(file, JSON.stringify({ ...receipt, createdAt: "2020-01-01T00:00:00.000Z" }));
    const edited = cli(["verify-receipt", file], { FORGET_USER_RECEIPT_KEY: "k1" });
    expect(edited.code).toBe(1);
    expect(edited.out).toContain("receipt was changed");
  });
});
