import { createClient, type Fetch } from "../http.js";
import type { Adapter, Found, Subject } from "../types.js";
import { emailVariants } from "./util.js";

interface User {
  id: string;
}

export interface ClerkOptions {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function clerk(secretKey: string, opts: ClerkOptions = {}): Adapter {
  const api = createClient({
    service: "clerk",
    base: "https://api.clerk.com",
    headers: { Authorization: `Bearer ${secretKey}` },
    fetch: opts.fetch,
    sleep: opts.sleep,
  });

  return {
    id: "clerk",
    name: "Clerk",

    async discover(subject: Subject) {
      const { body } = await api.request<User[]>("GET", "/v1/users", {
        query: { email_address: emailVariants(subject.email), limit: 100 },
      });
      return body.map(
        (u): Found => ({ service: "clerk", id: u.id, label: `user ${u.id}`, action: "delete" }),
      );
    },

    async apply(f) {
      const { status } = await api.request("DELETE", `/v1/users/${f.id}`, { allow: [404] });
      return status === 404 ? { status: "deleted", note: "already gone" } : { status: "deleted" };
    },
  };
}
