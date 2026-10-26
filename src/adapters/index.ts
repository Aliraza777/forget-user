import type { Fetch } from "../http.js";
import type { Action, Adapter, ServiceId } from "../types.js";
import { clerk } from "./clerk.js";
import { loops } from "./loops.js";
import { posthog } from "./posthog.js";
import { resend } from "./resend.js";
import { stripe } from "./stripe.js";

export const SERVICES: { id: ServiceId; env: string[]; optional?: string[] }[] = [
  { id: "stripe", env: ["STRIPE_SECRET_KEY"] },
  {
    id: "posthog",
    env: ["POSTHOG_PERSONAL_API_KEY", "POSTHOG_PROJECT_ID"],
    optional: ["POSTHOG_HOST"],
  },
  { id: "clerk", env: ["CLERK_SECRET_KEY"] },
  { id: "resend", env: ["RESEND_API_KEY"] },
  { id: "loops", env: ["LOOPS_API_KEY"] },
];

export interface FromEnvOptions {
  only?: ServiceId[];
  stripeCharged: Action;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface Configured {
  adapters: Adapter[];
  /** Services that have some but not all of their variables set. */
  incomplete: { id: ServiceId; missing: string[] }[];
}

/** A service is used when all its environment variables are set. */
export function adaptersFromEnv(
  env: Record<string, string | undefined>,
  o: FromEnvOptions,
): Configured {
  const adapters: Adapter[] = [];
  const incomplete: Configured["incomplete"] = [];
  const deps = { fetch: o.fetch, sleep: o.sleep };
  for (const s of SERVICES) {
    if (o.only && !o.only.includes(s.id)) continue;
    const missing = s.env.filter((k) => !env[k]);
    if (missing.length === s.env.length) {
      if (o.only) incomplete.push({ id: s.id, missing });
      continue;
    }
    if (missing.length) {
      incomplete.push({ id: s.id, missing });
      continue;
    }
    const v = (k: string) => env[k] as string;
    if (s.id === "stripe")
      adapters.push(stripe(v("STRIPE_SECRET_KEY"), { charged: o.stripeCharged, ...deps }));
    if (s.id === "posthog")
      adapters.push(
        posthog(v("POSTHOG_PERSONAL_API_KEY"), {
          projectId: v("POSTHOG_PROJECT_ID"),
          host: env.POSTHOG_HOST || "https://us.posthog.com",
          ...deps,
        }),
      );
    if (s.id === "clerk") adapters.push(clerk(v("CLERK_SECRET_KEY"), deps));
    if (s.id === "resend") adapters.push(resend(v("RESEND_API_KEY"), deps));
    if (s.id === "loops") adapters.push(loops(v("LOOPS_API_KEY"), deps));
  }
  return { adapters, incomplete };
}
