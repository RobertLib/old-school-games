-- Restores a nullable "id" on cache_epochs, set to 1 on the broad scope only.
--
-- 0039 dropped the column, but the code that was deployed while 0039 ran
-- still addresses the counter as `WHERE "id" = 1` — on every 10-second sync
-- and on every comment. Fly's release_command applies migrations before the
-- new machines take traffic, so there is always a window in which the old
-- code runs against the new schema; without this column that window logs a
-- failed query every interval on every machine and cross-machine cache
-- invalidation stops until the deploy completes. utils/cache-epoch.ts does
-- not read this column; it exists so the previous release keeps working.
-- Nullable and unique rather than a primary key so narrower scopes need no
-- value. Safe to drop in a later migration once no release addresses it.
ALTER TABLE "cache_epochs" ADD COLUMN "id" SMALLINT UNIQUE;

UPDATE "cache_epochs" SET "id" = 1 WHERE "scope" = 'all';
