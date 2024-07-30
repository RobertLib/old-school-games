-- "games"."slug" was added in 0008 as a nullable UNIQUE column and never made
-- NOT NULL, unlike "news"."slug" (0019). Every TypeScript type reads it as a
-- string, findBySlug looks it up, and the sitemap writes "/<slug>" for every
-- game — so a row created before 0008 and never re-saved was emitted as
-- "/null" and reachable from nowhere. 0021 skipped the same rows when it
-- filled the slug history, so they have no history either.
--
-- Backfilled the way 0019 did for news, then the constraint the column
-- should have carried from the start. The generated slug goes to the
-- history table too, so that a later rename keeps this address resolving.
--
-- One statement for the backfill, because the UNIQUE constraint is checked
-- row by row: a first pass writing every title's slug and a second pass
-- fixing the collisions fails on the first pass — "doom" for a second Doom
-- while the first still holds it. So each row's slug is decided before any
-- is written. A title-derived slug that is already live on another game,
-- already in another game's history, or shared with an earlier row of this
-- same batch takes the row's id as a suffix, which no title can produce
-- against that id; a title reducing to nothing takes the bare id.
--
-- The one collision this cannot rule out is an existing slug that happens to
-- equal "<base>-<id>" — a game already at "doom-7" and a seventh row titled
-- Doom. The constraint then fails the migration loudly, which is the right
-- outcome for a case that wants a human, as 0022 and 0024 do for theirs.
WITH "candidates" AS (
  SELECT
    "id",
    COALESCE(
      NULLIF(
        REGEXP_REPLACE(
          REGEXP_REPLACE(
            REGEXP_REPLACE(LOWER("title"), '[^a-z0-9]', '-', 'g'),
            '-+', '-', 'g'
          ),
          '^-|-$', '', 'g'
        ),
        ''
      ),
      "id"::text
    ) AS "base"
  FROM "games"
  WHERE "slug" IS NULL
)
UPDATE "games" g
SET "slug" = CASE
  WHEN EXISTS (
         SELECT 1 FROM "games" o WHERE o."slug" = c."base"
       )
    OR EXISTS (
         SELECT 1 FROM "game_slugs" h
         WHERE h."slug" = c."base" AND h."gameId" <> c."id"
       )
    OR EXISTS (
         SELECT 1 FROM "candidates" o
         WHERE o."base" = c."base" AND o."id" < c."id"
       )
  THEN c."base" || '-' || c."id"
  ELSE c."base"
END
FROM "candidates" c
WHERE c."id" = g."id";

INSERT INTO "game_slugs" ("gameId", "slug")
SELECT "id", "slug" FROM "games"
ON CONFLICT ("slug") DO NOTHING;

ALTER TABLE "games" ALTER COLUMN "slug" SET NOT NULL;
