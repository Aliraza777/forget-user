export type ServiceId = "stripe" | "posthog" | "clerk" | "resend" | "loops";

/** Who to forget. The email is required; the app's own user id finds records keyed by it. */
export interface Subject {
  email: string;
  userId?: string;
}

/**
 * What to do with a record:
 * - delete: remove it.
 * - scrub: keep the record but clear the personal fields on it.
 * - retain: keep it untouched, for a stated legal reason.
 */
export type Action = "delete" | "scrub" | "retain";

/** One record a service holds about the subject. */
export interface Found {
  service: ServiceId;
  id: string;
  /** What the service's delete call takes, when that isn't `id` (e.g. Loops deletes by email). */
  handle?: string;
  label: string;
  action: Action;
  /** Why the record is scrubbed or retained instead of deleted. */
  reason?: string;
  warnings?: string[];
}

/** pending: the service accepted the request but finishes it in the background. */
export type Status = "deleted" | "scrubbed" | "retained" | "pending" | "failed";

export interface Applied {
  status: Status;
  note?: string;
}

export interface Outcome extends Found {
  status: Status;
  note?: string;
  error?: string;
  /** Set after a delete: true when a fresh lookup no longer finds the record. */
  verified?: boolean;
}

export interface Adapter {
  id: ServiceId;
  name: string;
  discover(subject: Subject): Promise<Found[]>;
  apply(found: Found): Promise<Applied>;
  /** Data the service keeps that its API cannot delete, to handle by hand. */
  manual?: string[];
}

export interface ServiceResult {
  service: ServiceId;
  name: string;
  found: Found[];
  error?: string;
  manual: string[];
}
