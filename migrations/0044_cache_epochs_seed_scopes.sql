-- Re-seeds a row for every scope in SCOPE_EFFECTS, because the seed is what
-- makes the first bump of a scope visible on any other machine.
--
-- 0039 seeded 'comments' and carried 0033's row forward as 'all', and
-- bumpCacheEpoch has since become an upsert — so a scope with no row is no
-- longer a silent no-op. It is still not harmless, and the comment above
-- SCOPE_EFFECTS overstates how much the upsert repairs:
--
--   - the bump INSERTs the row at the column default, 1;
--   - syncCacheEpoch only counts a scope as moved when it has a previous
--     value for it and the new one is greater ("seen !== undefined && epoch >
--     seen"), which is deliberate — a scope read for the first time must be
--     adopted, not treated as an invalidation;
--   - so every other machine meets that scope at 1 for the first time,
--     adopts it, and applies no effect.
--
-- The write that created the row therefore invalidates nothing anywhere. The
-- machine that took it dropped its own caches by hand; every other machine
-- goes on serving the stale ones until the *second* bump. For 'all' that is a
-- deleted game still in another machine's sitemap and feed.
--
-- The invariant that makes cross-machine invalidation work is "every scope
-- has a row put there by a migration, before any code bumps it", and this
-- file restates it for the scopes that exist today. ON CONFLICT DO NOTHING,
-- so a scope already seeded — or already created by a bump — keeps the
-- counter it has: resetting one to 1 would move it backwards, which is the
-- one thing `adopt` and lastSeen in utils/cache-epoch.ts exist to make
-- impossible.
--
-- A scope added to SCOPE_EFFECTS later needs its own seed migration, for the
-- same reason.
INSERT INTO "cache_epochs" ("scope") VALUES
  ('all'),
  ('comments')
ON CONFLICT ("scope") DO NOTHING;
