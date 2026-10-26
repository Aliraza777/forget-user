import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Executed } from "./run.js";
import type { Status, Subject } from "./types.js";
import { VERSION } from "./version.js";

/**
 * Proof of what was done, safe to keep: it names the subject only by hash, so the
 * receipt doesn't hold the personal data it proves was deleted.
 */
export interface Receipt {
  tool: "forget-user";
  version: string;
  createdAt: string;
  subject: { email: string; userId?: string; hash: "hmac-sha256" | "sha256" };
  services: {
    service: string;
    error?: string;
    outcomes: {
      id: string;
      label: string;
      action: string;
      status: Status;
      verified?: boolean;
      reason?: string;
      note?: string;
      error?: string;
    }[];
    manual: string[];
  }[];
  summary: Record<Status, number>;
  /** HMAC-SHA256 of the rest of the receipt, present when a receipt key was given. */
  signature?: string;
}

export function buildReceipt(
  subject: Subject,
  executed: Executed[],
  key?: string,
  now = new Date(),
): Receipt {
  const summary: Record<Status, number> = {
    deleted: 0,
    scrubbed: 0,
    retained: 0,
    pending: 0,
    failed: 0,
  };
  for (const e of executed) for (const o of e.outcomes) summary[o.status]++;
  const hide = redactor(subject);
  const receipt: Receipt = {
    tool: "forget-user",
    version: VERSION,
    createdAt: now.toISOString(),
    subject: {
      email: digest(subject.email.trim().toLowerCase(), key),
      ...(subject.userId ? { userId: digest(subject.userId, key) } : {}),
      hash: key ? "hmac-sha256" : "sha256",
    },
    services: executed.map((e) => ({
      service: e.service,
      ...(e.error ? { error: hide(e.error) } : {}),
      outcomes: e.outcomes.map((o) => ({
        id: o.id,
        label: hide(o.label),
        action: o.action,
        status: o.status,
        ...(o.verified !== undefined ? { verified: o.verified } : {}),
        ...(o.reason ? { reason: hide(o.reason) } : {}),
        ...(o.note ? { note: hide(o.note) } : {}),
        ...(o.error ? { error: hide(o.error) } : {}),
      })),
      manual: e.manual,
    })),
    summary,
  };
  if (key) receipt.signature = sign(receipt, key);
  return receipt;
}

export type ReceiptCheck =
  | { ok: true }
  | { ok: false; reason: "unsigned" | "mismatch" | "invalid" };

/** Check a receipt's signature, and optionally that it is about a given email. */
export function verifyReceipt(raw: unknown, key: string, email?: string): ReceiptCheck {
  const r = raw as Receipt;
  if (r?.tool !== "forget-user" || !r.subject) return { ok: false, reason: "invalid" };
  if (!r.signature) return { ok: false, reason: "unsigned" };
  const expected = Buffer.from(sign(r, key), "hex");
  const actual = Buffer.from(r.signature, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    return { ok: false, reason: "mismatch" };
  if (email !== undefined && r.subject.email !== digest(email.trim().toLowerCase(), key))
    return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/** Vendor error messages can quote the request path, which may hold the email or user id. */
function redactor(subject: Subject): (s: string) => string {
  const values = [subject.email.trim(), subject.userId].filter((v): v is string => !!v);
  const forms = [
    ...new Set(
      values.flatMap((v) => [
        v,
        v.toLowerCase(),
        encodeURIComponent(v),
        encodeURIComponent(v.toLowerCase()),
      ]),
    ),
  ].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(forms.map(escape).join("|"), "gi");
  return (s) => s.replace(pattern, "[subject]");
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function digest(value: string, key: string | undefined): string {
  return key
    ? createHmac("sha256", key).update(value).digest("hex")
    : createHash("sha256").update(value).digest("hex");
}

function sign(r: Receipt, key: string): string {
  const { signature: _, ...rest } = r;
  return createHmac("sha256", key).update(canonical(rest)).digest("hex");
}

/** JSON with sorted keys, so a receipt re-saved by another tool still verifies. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}
