-- One counter per *scope* rather than one counter for the whole app.
--
-- 0033 created a single row, and every write bumped it: a posted comment made
-- every other machine run clearAllCaches() and throw away the sitemap (24h),
-- the feeds, the rankings and the game-of-the-week pick — while the machine
-- that took the comment had dropped exactly one sidebar entry. Comments are
-- the most frequent write on the site, so the cross-machine effect of the
-- cheapest write was the most expensive invalidation available.
--
-- The invariant the scopes restore is that a remote machine drops exactly what
-- the writing machine dropped locally. See utils/cache-epoch.ts for the scope
-- names and what each one clears.
--
-- The row from 0033 becomes the broad scope, so a machine mid-deploy that has
-- already read epoch N under the old shape carries on comparing against the
-- same number.
ALTER TABLE "cache_epochs" ADD COLUMN "scope" TEXT;

UPDATE "cache_epochs" SET "scope" = 'all';

ALTER TABLE "cache_epochs" DROP CONSTRAINT "cache_epochs_id_check";
ALTER TABLE "cache_epochs" DROP CONSTRAINT "cache_epochs_pkey";
ALTER TABLE "cache_epochs" DROP COLUMN "id";

ALTER TABLE "cache_epochs" ALTER COLUMN "scope" SET NOT NULL;
ALTER TABLE "cache_epochs" ADD PRIMARY KEY ("scope");

-- Seeded rather than created on demand: bumpCacheEpoch is an UPDATE, and a
-- scope with no row would silently bump nothing at all.
INSERT INTO "cache_epochs" ("scope") VALUES ('comments')
  ON CONFLICT DO NOTHING;
