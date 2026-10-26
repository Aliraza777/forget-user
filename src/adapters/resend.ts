import { createClient, type Fetch } from "../http.js";
import type { Adapter, Found, Subject } from "../types.js";
import { emailVariants } from "./util.js";

export interface ResendOptions {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function resend(apiKey: string, opts: ResendOptions = {}): Adapter {
  const api = createClient({
    service: "resend",
    base: "https://api.resend.com",
    headers: { Authorization: `Bearer ${apiKey}` },
    fetch: opts.fetch,
    sleep: opts.sleep,
  });

  return {
    id: "resend",
    name: "Resend",
    manual: [
      "Logs of emails already sent to this address can't be deleted through the API; they expire with your plan's log retention, or ask Resend support.",
    ],

    async discover(subject: Subject) {
      const found = new Map<string, Found>();
      for (const email of emailVariants(subject.email)) {
        const { status, body } = await api.request<{ id: string; email: string }>(
          "GET",
          `/contacts/${encodeURIComponent(email)}`,
          { allow: [404] },
        );
        if (status === 404) continue;
        found.set(body.id, {
          service: "resend",
          id: body.id,
          label: `contact ${body.id}`,
          action: "delete",
        });
      }
      return [...found.values()];
    },

    async apply(f) {
      const { status } = await api.request("DELETE", `/contacts/${encodeURIComponent(f.id)}`, {
        allow: [404],
      });
      return status === 404 ? { status: "deleted", note: "already gone" } : { status: "deleted" };
    },
  };
}
