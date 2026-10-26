import type { Adapter, Outcome, ServiceResult, Subject } from "./types.js";

/** Read-only: ask every service what it holds about the subject. One failing service doesn't stop the rest. */
export async function discover(adapters: Adapter[], subject: Subject): Promise<ServiceResult[]> {
  return Promise.all(
    adapters.map(async (a): Promise<ServiceResult> => {
      const base = { service: a.id, name: a.name, manual: a.manual ?? [] };
      try {
        return { ...base, found: await a.discover(subject) };
      } catch (e) {
        return { ...base, found: [], error: message(e) };
      }
    }),
  );
}

export interface Executed extends Omit<ServiceResult, "found"> {
  outcomes: Outcome[];
}

/**
 * Apply each planned action, then look the subject up again so every delete is checked
 * against the service itself rather than trusting the API's success response.
 */
export async function execute(
  adapters: Adapter[],
  results: ServiceResult[],
  subject: Subject,
): Promise<Executed[]> {
  return Promise.all(
    results.map(async (r): Promise<Executed> => {
      const { found, ...rest } = r;
      const adapter = adapters.find((a) => a.id === r.service);
      if (!adapter || r.error) return { ...rest, outcomes: [] };

      const outcomes: Outcome[] = [];
      for (const f of found) {
        try {
          outcomes.push({ ...f, ...(await adapter.apply(f)) });
        } catch (e) {
          outcomes.push({ ...f, status: "failed", error: message(e) });
        }
      }

      if (outcomes.some((o) => o.status === "deleted")) {
        try {
          const still = new Set((await adapter.discover(subject)).map((f) => f.id));
          for (const o of outcomes) if (o.status === "deleted") o.verified = !still.has(o.id);
        } catch (e) {
          return {
            ...rest,
            outcomes,
            error: `deleted, but the check afterwards failed: ${message(e)}`,
          };
        }
      }
      return { ...rest, outcomes };
    }),
  );
}

export const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
