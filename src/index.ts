import { adaptersFromEnv } from "./adapters/index.js";
import { buildReceipt, type Receipt } from "./receipt.js";
import { discover, type Executed, execute } from "./run.js";
import type { Action, Adapter, ServiceResult, Subject } from "./types.js";

export { clerk } from "./adapters/clerk.js";
export { adaptersFromEnv, SERVICES } from "./adapters/index.js";
export { loops } from "./adapters/loops.js";
export { posthog } from "./adapters/posthog.js";
export { resend } from "./adapters/resend.js";
export { stripe } from "./adapters/stripe.js";
export { buildReceipt, type Receipt, verifyReceipt } from "./receipt.js";
export { discover, type Executed, execute } from "./run.js";
export type * from "./types.js";

export interface ForgetOptions {
  /** Services to use. Default: every service whose keys are in `env`. */
  adapters?: Adapter[];
  /** Where to read service keys from when `adapters` isn't given. Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Stripe customers who were ever charged. Default: "retain". */
  stripeCharged?: Action;
  /** Actually delete. Default: false, which only reports what would happen. */
  confirm?: boolean;
  /** Signs the receipt and keys the subject hash. Default: env.FORGET_USER_RECEIPT_KEY. */
  receiptKey?: string;
}

export type ForgetResult =
  | { done: false; reason: "dry-run" | "service-error"; found: ServiceResult[] }
  | { done: true; ok: boolean; found: ServiceResult[]; executed: Executed[]; receipt: Receipt };

/**
 * Find the user in every service and, with `confirm: true`, delete them, check the
 * deletes, and return a receipt. Nothing is changed if any service can't be checked.
 * `ok` is false when an action failed or a record was still found afterwards.
 */
export async function forgetUser(
  subject: Subject,
  opts: ForgetOptions = {},
): Promise<ForgetResult> {
  const env = opts.env ?? process.env;
  let adapters = opts.adapters;
  if (!adapters) {
    const configured = adaptersFromEnv(env, { stripeCharged: opts.stripeCharged ?? "retain" });
    if (configured.incomplete.length)
      throw new Error(
        configured.incomplete.map((i) => `${i.id}: set ${i.missing.join(" and ")}`).join("; "),
      );
    adapters = configured.adapters;
  }
  if (!adapters.length) throw new Error("forget-user: no services configured");

  const found = await discover(adapters, subject);
  if (found.some((r) => r.error)) return { done: false, reason: "service-error", found };
  if (!opts.confirm) return { done: false, reason: "dry-run", found };

  const executed = await execute(adapters, found, subject);
  const receipt = buildReceipt(subject, executed, opts.receiptKey ?? env.FORGET_USER_RECEIPT_KEY);
  const ok = !executed.some(
    (e) => e.error || e.outcomes.some((o) => o.status === "failed" || o.verified === false),
  );
  return { done: true, ok, found, executed, receipt };
}
