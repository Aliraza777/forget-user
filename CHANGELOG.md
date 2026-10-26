# Changelog

## 0.1.0

First release.

- `forget-user discover`, `delete` (dry run unless `--confirm`) and `verify-receipt`.
- Services: Stripe, PostHog, Clerk, Resend, Loops.
- Stripe customers who were ever charged are retained by default; `--stripe-charged scrub|delete` changes that.
- Every delete is checked by looking the user up again afterwards.
- Receipts name the user only by hash and can be signed with `FORGET_USER_RECEIPT_KEY`.
- Nothing is deleted if any service can't be checked.
- Library API: `forgetUser()` plus the individual adapters, with TypeScript types.
