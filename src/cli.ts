import { readFileSync, writeFileSync } from "node:fs";
import { Command, Option } from "commander";
import pc from "picocolors";
import { adaptersFromEnv, SERVICES } from "./adapters/index.js";
import { buildReceipt, verifyReceipt } from "./receipt.js";
import { hasProblems, renderPlan, renderResult } from "./report.js";
import { discover, execute } from "./run.js";
import type { Action, ServiceId, Subject } from "./types.js";
import { VERSION } from "./version.js";

const IDS = SERVICES.map((s) => s.id);

const program = new Command()
  .name("forget-user")
  .description(
    "Delete one user from every service your app uses, for GDPR/CCPA erasure requests. Services are picked up from their API keys in the environment.",
  )
  .version(VERSION);

const shared = (cmd: Command) =>
  cmd
    .argument("<email>", "the user's email address")
    .option("-u, --user-id <id>", "your app's id for the user (PostHog distinct id, Loops userId)")
    .option("--only <services>", `comma-separated subset of: ${IDS.join(", ")}`, parseOnly)
    .addOption(
      new Option("--stripe-charged <action>", "Stripe customers who were ever charged")
        .choices(["retain", "scrub", "delete"])
        .default("retain"),
    )
    .addOption(
      new Option("-f, --format <format>", "output format")
        .choices(["text", "json"])
        .default("text"),
    );

shared(program.command("discover"))
  .description("show what each service holds about the user, without changing anything")
  .action(async (email: string, opts) => {
    const { subject, adapters } = setup(email, opts);
    const results = await discover(adapters, subject);
    print(opts.format, results, () => renderPlan(subject, results, false));
    if (results.some((r) => r.error)) process.exitCode = 1;
  });

shared(program.command("delete"))
  .description("delete the user everywhere (a dry run unless --confirm is given)")
  .option("--confirm", "actually delete; without it nothing is changed")
  .option(
    "--receipt <path>",
    "where to write the receipt (default: forget-user-receipt-<time>.json)",
  )
  .option("--no-receipt", "don't write a receipt")
  .action(async (email: string, opts) => {
    const { subject, adapters } = setup(email, opts);
    const results = await discover(adapters, subject);
    if (!opts.confirm) {
      print(opts.format, { dryRun: true, services: results }, () =>
        renderPlan(subject, results, true),
      );
      if (results.some((r) => r.error)) process.exitCode = 1;
      return;
    }
    if (results.some((r) => r.error)) {
      // Deleting from some services but not others leaves a half-forgotten user; fix access first.
      print(opts.format, { aborted: true, services: results }, () =>
        renderPlan(subject, results, false),
      );
      fail("Not deleting anything: a service could not be checked (see above).");
    }
    const executed = await execute(adapters, results, subject);
    const receipt = buildReceipt(subject, executed, process.env.FORGET_USER_RECEIPT_KEY);
    const receiptPath: string | undefined =
      opts.receipt === false
        ? undefined
        : typeof opts.receipt === "string"
          ? opts.receipt
          : `forget-user-receipt-${receipt.createdAt.replace(/[:.]/g, "-")}.json`;
    if (receiptPath) writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    print(opts.format, receipt, () => renderResult(subject, executed, receiptPath));
    if (hasProblems(executed)) process.exitCode = 1;
  });

program
  .command("verify-receipt")
  .description("check a receipt's signature (needs the same FORGET_USER_RECEIPT_KEY)")
  .argument("<file>", "receipt JSON file")
  .option("--email <email>", "also check the receipt is about this email")
  .action((file: string, opts) => {
    const key = process.env.FORGET_USER_RECEIPT_KEY;
    if (!key) fail("Set FORGET_USER_RECEIPT_KEY to the key the receipt was signed with.");
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      fail(`Can't read ${file}: ${e instanceof Error ? e.message : e}`);
    }
    const check = verifyReceipt(raw, key as string, opts.email);
    if (check.ok) {
      process.stdout.write(
        `${pc.green("✓")} Signature valid${opts.email ? " and matches the email" : ""}.\n`,
      );
      return;
    }
    const why = {
      unsigned: "The receipt has no signature (it was written without FORGET_USER_RECEIPT_KEY).",
      mismatch: opts.email
        ? "Signature doesn't match, or the receipt is about a different email."
        : "Signature doesn't match: the receipt was changed or signed with another key.",
      invalid: "This isn't a forget-user receipt.",
    }[check.reason];
    process.stdout.write(`${pc.red("✗")} ${why}\n`);
    process.exitCode = 1;
  });

function setup(
  email: string,
  opts: { userId?: string; only?: ServiceId[]; stripeCharged: Action },
) {
  if (!/^[^\s@]+@[^\s@]+$/.test(email.trim()))
    fail(`"${email}" doesn't look like an email address.`);
  const subject: Subject = { email: email.trim(), ...(opts.userId ? { userId: opts.userId } : {}) };
  const { adapters, incomplete } = adaptersFromEnv(process.env, {
    only: opts.only,
    stripeCharged: opts.stripeCharged,
  });
  if (incomplete.length)
    fail(incomplete.map((i) => `${i.id}: set ${i.missing.join(" and ")}`).join("\n"));
  if (!adapters.length)
    fail(
      [
        "No services configured. Set the API keys for the services your app uses:",
        ...SERVICES.map(
          (s) =>
            `  ${s.id.padEnd(8)} ${s.env.join(", ")}${s.optional ? pc.dim(` (optional: ${s.optional.join(", ")})`) : ""}`,
        ),
      ].join("\n"),
    );
  return { subject, adapters };
}

function parseOnly(value: string): ServiceId[] {
  const ids = value.split(",").map((s) => s.trim().toLowerCase());
  const bad = ids.filter((id) => !IDS.includes(id as ServiceId));
  if (bad.length) fail(`Unknown service: ${bad.join(", ")}. Known: ${IDS.join(", ")}`);
  return ids as ServiceId[];
}

function print(format: string, data: unknown, text: () => string) {
  process.stdout.write(format === "json" ? `${JSON.stringify(data, null, 2)}\n` : `${text()}\n`);
}

function fail(msg: string): never {
  process.stderr.write(`${pc.red("error")} ${msg}\n`);
  process.exit(2);
}

await program.parseAsync();
