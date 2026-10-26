# forget-user

Delete one user from every service your app uses, for GDPR and CCPA erasure requests and "delete my account" buttons.

```sh
npx forget-user delete ann@example.com            # dry run: shows what would happen
npx forget-user delete ann@example.com --confirm  # does it, checks it, writes a receipt
```

When someone asks to be forgotten, deleting them from your own database is the easy part. Their data also sits in Stripe, PostHog, your auth provider and your email tool. Today that means a checklist of dashboards, or a hand-written script per app. The tools that automate it (Transcend, DataGrail and similar) are enterprise platforms sold through a sales team.

forget-user does the vendor side from one command:

- **Finds the user first.** `discover` shows every record each service holds, before anything is changed.
- **Dry run by default.** `delete` only changes data with `--confirm`.
- **Keeps what you must keep.** A Stripe customer who was charged is retained by default, because payment records usually have to be kept for tax and fraud rules. Choose `--stripe-charged scrub` to clear their personal fields instead, or `delete`.
- **Checks its own work.** After deleting, it looks the user up again in each service and reports anything still there.
- **Writes a receipt.** A JSON record of what was deleted, scrubbed or kept and why. It names the user only by hash, and can be signed so later edits are detectable.
- **Lists what it can't do.** Some data has no deletion API (e.g. logs of emails already sent). Those items are printed as a to-do list instead of being silently skipped.

## Example

```text
$ npx forget-user delete ann@example.com --user-id u_123

forget-user · plan · ann@example.com / u_123 · 4 services

  Stripe
    DELETE  customer cus_Q1 (never charged)
            ⚠ deleting cancels 1 active subscription immediately
    RETAIN  customer cus_Q7 (3 successful charges)
            ↳ 3 successful charges: payment records are usually kept for tax and fraud rules
  PostHog
    DELETE  person 0190f… (2 distinct ids)
  Clerk
    DELETE  user user_2x…
  Resend  nothing found

  Handle by hand
    • Stripe: Charges, invoices and receipts keep their own copy of billing details. …
    • Resend: Logs of emails already sent to this address can't be deleted through the API; …

  Dry run: nothing was changed. Run again with --confirm to apply.
```

## Setup

A service is used when its API keys are in the environment. Set the ones your app uses.

| Service | Variables | What is deleted | Key needs |
| --- | --- | --- | --- |
| Stripe | `STRIPE_SECRET_KEY` | Customers matching the email. Charged customers are retained by default (`--stripe-charged`). Deleting a customer cancels its subscriptions. | Restricted key: Customers write, Charges read, Subscriptions read |
| PostHog | `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, optional `POSTHOG_HOST` (default `https://us.posthog.com`) | Persons matching the email or `--user-id` (distinct id), with their events and session recordings | Personal API key with person read and write |
| Clerk | `CLERK_SECRET_KEY` | Users with the email | Secret key |
| Resend | `RESEND_API_KEY` | The contact with the email | Full-access key (sending-only keys can't manage contacts) |
| Loops | `LOOPS_API_KEY` | Contacts with the email or `--user-id` | API key |

Use `--only stripe,clerk` to limit a run to some services.

The email is looked up both as given and in lowercase, because some services (Stripe's customer lookup, for one) match emails case-sensitively.

## Commands

```text
forget-user discover <email> [--user-id <id>]   what each service holds, read-only
forget-user delete <email> [--user-id <id>]     dry run; add --confirm to apply
forget-user verify-receipt <file> [--email <e>] check a signed receipt
```

Common options: `--only <services>`, `--stripe-charged retain|scrub|delete`, `--format text|json`.
`delete` also takes `--receipt <path>` and `--no-receipt`.

If any service can't be checked (wrong key, outage), `delete --confirm` stops before deleting anything, so a user is never left half-deleted.

Exit codes: `0` success, `1` something failed or was still found afterwards, `2` usage or setup error.

## Receipts

`delete --confirm` writes `forget-user-receipt-<time>.json` (or `--receipt <path>`). It records each service, record id, action, status and the reason for anything kept. It names the user only by a hash of their email and user id, and removes them from any vendor error messages it quotes.

Set `FORGET_USER_RECEIPT_KEY` to sign receipts with HMAC-SHA256. The hash of the subject then uses the key too, so it can't be reversed by guessing emails. Later, to prove a receipt is unchanged and about a given person:

```sh
FORGET_USER_RECEIPT_KEY=… npx forget-user verify-receipt receipt.json --email ann@example.com
```

## Status

Version 0.1. The adapters follow each vendor's current API (checked October 2026 against their official SDKs). The test suite checks every request against a fake HTTP layer, but they have not yet been run against live test-mode accounts. Try `discover` and a dry run on a test account before relying on it.

This is a tool, not legal advice: what you must delete or keep depends on your jurisdiction and contracts.

## Adding a service

Each service is one file in `src/adapters/` with two functions: `discover(subject)`, which returns the records found and what to do with each, and `apply(record)`, which carries that action out. Pull requests for more services are welcome.

## License

MIT
