# Decide cell access once per request, at the route, by the item it names

Every request that touches cell-owned data names one cell-owned item in its URL (`/requirements/7/indicators/42`), and one dispatcher decides whether the user may see, change, release or reassign that item before any store code runs; stores receive the item and never see the user, and the live update goes to the item's cells. We chose this after two leaks in one week came from access checks hand-called in about 130 places across three stores: with one decision per request, a forgotten check is no longer possible for anything reached through a route. Consequences: every part stores its item's id, an evidence link is a part of the requirement it supports (not of the report it cites), and the only access a store still composes itself is the visibility condition in list queries, guarded by a per-module sweep test generated from the route table.

## Considered options

- **Checks inside each store through a shared ownership module.** Rejected: it keeps one call per store operation that can still be forgotten.
- **Enforcement in the database (SQLite functions, per-connection views, triggers, a change log).** Rejected for now: it needs generated triggers and views on about 20 tables, and a hidden current user. It belongs in Phase 2, where PostgreSQL row-level security does this natively and can mirror the dispatcher's item and verb decisions.
