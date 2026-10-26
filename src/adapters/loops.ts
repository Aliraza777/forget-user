import { createClient, type Fetch } from "../http.js";
import type { Adapter, Found, Subject } from "../types.js";
import { emailVariants } from "./util.js";

interface Contact {
  id: string;
  email: string;
}

export interface LoopsOptions {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function loops(apiKey: string, opts: LoopsOptions = {}): Adapter {
  const api = createClient({
    service: "loops",
    base: "https://app.loops.so",
    headers: { Authorization: `Bearer ${apiKey}` },
    fetch: opts.fetch,
    sleep: opts.sleep,
  });

  return {
    id: "loops",
    name: "Loops",

    async discover(subject: Subject) {
      const found = new Map<string, Found>();
      const lookups: Record<string, string>[] = emailVariants(subject.email).map((email) => ({
        email,
      }));
      if (subject.userId) lookups.push({ userId: subject.userId });
      for (const query of lookups) {
        const { body } = await api.request<Contact[]>("GET", "/api/v1/contacts/find", { query });
        for (const c of body)
          found.set(c.id, {
            service: "loops",
            id: c.id,
            handle: c.email,
            label: `contact ${c.id}`,
            action: "delete",
          });
      }
      return [...found.values()];
    },

    async apply(f) {
      // Loops deletes by email or userId, not by contact id.
      const { status } = await api.request("POST", "/api/v1/contacts/delete", {
        json: { email: f.handle },
        allow: [404],
      });
      return status === 404 ? { status: "deleted", note: "already gone" } : { status: "deleted" };
    },
  };
}
