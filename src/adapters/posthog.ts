import { createClient, type Fetch } from "../http.js";
import type { Adapter, Found, Subject } from "../types.js";
import { emailVariants } from "./util.js";

interface Person {
  id: string;
  distinct_ids: string[];
}

export interface PostHogOptions {
  projectId: string;
  /** https://us.posthog.com, https://eu.posthog.com, or a self-hosted URL. */
  host: string;
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
}

export function posthog(personalApiKey: string, opts: PostHogOptions): Adapter {
  const api = createClient({
    service: "posthog",
    base: opts.host,
    headers: { Authorization: `Bearer ${personalApiKey}` },
    fetch: opts.fetch,
    sleep: opts.sleep,
  });
  const persons = `/api/projects/${encodeURIComponent(opts.projectId)}/persons/`;

  return {
    id: "posthog",
    name: "PostHog",

    async discover(subject: Subject) {
      const found = new Map<string, Found>();
      const lookups: Record<string, string>[] = emailVariants(subject.email).map((email) => ({
        email,
      }));
      if (subject.userId) lookups.push({ distinct_id: subject.userId });
      for (const query of lookups) {
        const { body } = await api.request<{ results: Person[] }>("GET", persons, { query });
        for (const p of body.results)
          found.set(p.id, {
            service: "posthog",
            id: p.id,
            label: `person ${p.id} (${p.distinct_ids.length} distinct id${p.distinct_ids.length === 1 ? "" : "s"})`,
            action: "delete",
          });
      }
      return [...found.values()];
    },

    async apply(f) {
      // The per-person DELETE is deprecated in favour of bulk_delete (PostHog PR #43923).
      // The person goes at once; events and recordings are removed by a background job.
      const { body } = await api.request<{ deletion_errors?: { person_uuid: string }[] } | null>(
        "POST",
        `${persons}bulk_delete/`,
        { json: { ids: [f.id], delete_events: true, delete_recordings: true } },
      );
      if (body?.deletion_errors?.length) throw new Error(`PostHog could not delete person ${f.id}`);
      return {
        status: "deleted",
        note: "events and session recordings are deleted by a PostHog background job",
      };
    },
  };
}
