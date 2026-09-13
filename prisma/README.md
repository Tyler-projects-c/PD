# Prisma Migrate — operating notes for this database

The `events`, `experiment_assignments`, `product_surface_stats`, `compliance_requests`,
etc. database is a **Neon Postgres** instance. It was originally created with raw SQL
(outside Prisma Migrate) and was baselined into Prisma Migrate on **2026-09-09**.

## How the baseline was created (do not repeat — it is done)

1. `prisma migrate diff --from-empty --to-url "$DIRECT_URL" --script` → generated
   `prisma/migrations/0_init/migration.sql` (all tables, columns, defaults, PKs, FKs,
   indexes). Verified `prisma migrate diff --from-schema-datamodel schema.prisma --to-url …`
   reports **"No difference detected"**.
2. `prisma/migrations/1_check_constraints/migration.sql` was hand-written to capture
   the **database-side CHECK constraints and the `pgcrypto` extension** — objects that
   Prisma's schema model **cannot represent** and so will never appear in a generated
   migration (see the header comment in that file).
3. Both migrations were recorded with `prisma migrate resolve --applied 0_init` and
   `prisma migrate resolve --applied 1_check_constraints` (records without executing;
   the live DB already matches). Verification after: `migrate status` = up to date,
   `migrate deploy` = no-op, row counts unchanged.

## How to evolve the schema from here

- **Dev:** make code changes to `prisma/schema.prisma`, then run
  `npm exec prisma migrate dev --name <description>` — it generates a new migration
  file and applies it. Review the generated SQL before committing.
- **CI/Prod:** `npm exec prisma migrate deploy` (applies only pending migrations).
- **Never** apply ad-hoc DDL to the shared Neon DB by hand. If you need a manual
  change, add it as a new migration's `migration.sql` (hand-written) and run
  `migrate deploy`.
- `npm exec prisma migrate status` before/after any deploy to confirm up to date.

## CHECK constraints live outside the Prisma model

Prisma's PostgreSQL provider does not model `CHECK` constraints. They exist only in
migration SQL. The canonical value sets are declared in the header of
`prisma/migrations/1_check_constraints/migration.sql` and mirrored below — **edit the
migration + this file together if they change**:

- `compliance_requests.topic`: `customers/data_request`, `customers/redact`, `shop/redact`
- `events.event_type`: `page_viewed`, `search_submitted`, `collection_viewed`,
  `product_viewed`, `product_added_to_cart`, `checkout_completed`, `product_impression`
  (must equal `EVENT_TYPES` in `app/routes/api.events.tsx`)
- `events.surface`: `search` \| `collection` \| NULL
- `events.variant`: `control` \| `treatment` \| NULL
- `experiment_assignments.surface`: `search` \| `collection`
- `experiment_assignments.variant`: `control` \| `treatment`
- `product_surface_stats.surface`: `search` \| `collection`
- `thompson_daily_rankings.surface`: `search` \| `collection`

## Environment / connections

- `.env` `DIRECT_URL` is used for DDL/migrations (Neon pooled `DATABASE_URL` cannot run
  some DDL). Keep `DIRECT_URL` pointing at the direct (non-pooled) connection.
- `gen_random_uuid()` defaults come from the `pgcrypto` extension (a Neon default, and
  created idempotently by both baseline migrations).