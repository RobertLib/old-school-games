-- One shared counter every process compares against on a timer, so a write
-- on one machine drops the in-memory caches on every other. See
-- utils/cache-epoch.ts. The CHECK pins the table to its single row.
CREATE TABLE "cache_epochs" (
  "id" SMALLINT PRIMARY KEY CHECK ("id" = 1),
  "epoch" BIGINT NOT NULL DEFAULT 1,
  "bumpedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO "cache_epochs" ("id") VALUES (1);
