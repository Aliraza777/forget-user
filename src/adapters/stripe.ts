import { createClient, type Fetch } from "../http.js";
import type { Action, Adapter, Found, Subject } from "../types.js";
import { emailVariants } from "./util.js";

interface Customer {
  id: string;
  email: string | null;
}
interface List<T> {
  data: T[];
  has_more: boolean;
}

/** Subscription statuses that still bill or grant access; deleting the customer cancels them. */
const LIVE = new Set(["active", "trialing", "past_due", "unpaid", "paused"]);

export interface StripeOptions {
  /** What to do with customers who were ever successfully charged. */
  charged: Action;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function stripe(secretKey: string, opts: StripeOptions): Adapter {
  const api = createClient({
    service: "stripe",
    base: "https://api.stripe.com",
    headers: { Authorization: `Bearer ${secretKey}` },
    fetch: opts.fetch,
    sleep: opts.sleep,
  });

  return {
    id: "stripe",
    name: "Stripe",
    manual: [
      "Charges, invoices and receipts keep their own copy of billing details. Stripe can redact those on request (Dashboard or support); payment records are usually kept for tax and fraud rules.",
    ],

    async discover(subject: Subject) {
      const found: Found[] = [];
      const seen = new Set<string>();
      // The customer list's email filter is case-sensitive, so try the address as given and lowercased.
      for (const email of emailVariants(subject.email)) {
        const { body } = await api.request<List<Customer>>("GET", "/v1/customers", {
          query: { email, limit: 100 },
        });
        for (const c of body.data) {
          if (seen.has(c.id)) continue;
          seen.add(c.id);
          found.push(await describe(c));
        }
      }
      return found;
    },

    async apply(f) {
      if (f.action === "retain") return { status: "retained" };
      if (f.action === "scrub") {
        // "" unsets a field. Charges and invoices keep their own copy (see `manual`).
        await api.request("POST", `/v1/customers/${f.id}`, {
          form: {
            name: "",
            email: "",
            phone: "",
            description: "",
            address: "",
            shipping: "",
            metadata: "",
          },
        });
        return { status: "scrubbed" };
      }
      const { status } = await api.request("DELETE", `/v1/customers/${f.id}`, { allow: [404] });
      return status === 404 ? { status: "deleted", note: "already gone" } : { status: "deleted" };
    },
  };

  async function describe(c: Customer): Promise<Found> {
    const charges = await api.request<List<{ status: string }>>("GET", "/v1/charges", {
      query: { customer: c.id, limit: 100 },
    });
    const paid = charges.body.data.filter((ch) => ch.status === "succeeded").length;
    const subs = await api.request<List<{ status: string }>>("GET", "/v1/subscriptions", {
      query: { customer: c.id, status: "all", limit: 100 },
    });
    const live = subs.body.data.filter((s) => LIVE.has(s.status)).length;

    const paidText = `${paid}${charges.body.has_more ? "+" : ""} successful charge${paid === 1 ? "" : "s"}`;
    const action: Action = paid > 0 ? opts.charged : "delete";
    const found: Found = {
      service: "stripe",
      id: c.id,
      label: `customer ${c.id} (${paid > 0 ? paidText : "never charged"})`,
      action,
    };
    if (action === "retain")
      found.reason = `${paidText}: payment records are usually kept for tax and fraud rules`;
    if (action === "scrub")
      found.reason = `${paidText}: keeping the customer, clearing name, email, phone, address and metadata`;
    if (live > 0 && action === "delete")
      found.warnings = [
        `deleting cancels ${live} active subscription${live === 1 ? "" : "s"} immediately`,
      ];
    if (live > 0 && action !== "delete")
      found.warnings = [`has ${live} active subscription${live === 1 ? "" : "s"}; cancel it first`];
    return found;
  }
}
