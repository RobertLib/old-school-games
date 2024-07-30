-- The two numbers every rating-ordered listing recomputes from the whole
-- "ratings" table, kept on the game itself.
--
-- models/game.ts has one query shape that cannot page before it aggregates:
-- a game's place in a rating ranking is not known until its votes have been
-- counted, so find() with orderBy "rating" — which is also the default
-- ordering for the catalogue with no filter on it — LEFT JOINs every game to
-- every vote, GROUP BYs the lot and only then takes twenty-five rows. So does
-- findTopRated for five, and loadFeaturedPool for forty. The homepage pays it
-- on a cold cache, and nothing about it gets cheaper as the catalogue grows:
-- it is O(games + ratings) for a page of 25.
--
-- WEIGHTED_RATING is (count * avg + 5 * siteMean) / (count + 5), and
-- count * avg is exactly SUM("rating"). So the whole of what the aggregate
-- contributes per game is a sum and a count, and both are maintainable
-- incrementally — which is what the trigger below does.
--
-- INTEGER rather than BIGINT: "rating" is CHECK (1..5) and one row per
-- ("gameId", "voterId"), so overflowing the sum needs ~429 million voters on
-- one game. BIGINT would cost eight bytes per game to insure against a
-- number the uniqueness of a vote already rules out.

ALTER TABLE "games"
  ADD COLUMN "ratingSum" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ratingCount" INTEGER NOT NULL DEFAULT 0;

-- Games with no votes keep the column defaults, which is the same 0/0 the
-- COALESCE(AVG(...), 0) and COUNT() in the old shape produced for them.
UPDATE "games" g
SET "ratingSum" = t."sum",
    "ratingCount" = t."count"
FROM (
  SELECT "gameId", SUM("rating") AS "sum", COUNT(*) AS "count"
  FROM "ratings"
  GROUP BY "gameId"
) t
WHERE t."gameId" = g."id";

-- The invariant stated to the database rather than only to the reader.
--
-- A denormalised total is worth exactly as much as the guarantee that it is
-- right, and the failure mode of a drifting counter is silent: a game sits
-- one place too high in a ranking and nothing anywhere says so. Every vote is
-- between 1 and 5 ("ratings_rating_check"), so a correct pair always
-- satisfies count <= sum <= 5 * count, and count = 0 forces sum = 0. A
-- trigger bug — or a hand-written UPDATE that forgets one of the two columns
-- — then fails loudly at the write instead, which is the stance 0022 and 0024
-- take for their own repairs.
ALTER TABLE "games"
  ADD CONSTRAINT "games_rating_totals_check"
  CHECK (
    "ratingCount" >= 0
    AND "ratingSum" >= "ratingCount"
    AND "ratingSum" <= 5 * "ratingCount"
  );

-- What keeps the pair exact, for every write models/game.ts actually makes.
--
-- Game.rate is an upsert:
--
--   INSERT INTO "ratings" ("gameId", "voterId", "ipAddress", "rating") ...
--   ON CONFLICT ("gameId", "voterId")
--   DO UPDATE SET "rating" = $4, "ipAddress" = $3, "createdAt" = NOW()
--
-- so a first vote arrives here as INSERT and a changed vote as UPDATE —
-- Postgres fires the UPDATE triggers on the DO UPDATE path, not the INSERT
-- ones. Game.pruneRatingIps UPDATEs "ipAddress" and nothing else; a deleted
-- game cascades its votes away as DELETEs. Each case:
--
--   INSERT               + NEW."rating", count + 1
--   DELETE               - OLD."rating", count - 1
--   UPDATE, same game    + NEW - OLD on the sum, count unchanged
--   UPDATE, moved game   the two above, one per game
--   UPDATE, neither the
--   rating nor the game
--   changed              nothing at all
--
-- The last row is not a micro-optimisation. Re-voting the same number is the
-- common case of the upsert (a visitor clicking the star they already chose)
-- and pruneRatingIps rewrites "ipAddress" on every row in a retention sweep;
-- without the early return each of those takes a row lock on the game and
-- writes a new version of it, so a prune would rewrite most of "games" and
-- one hot game would serialise its re-votes behind a row it does not need to
-- touch.
--
-- "gameId" is NOT NULL — 0011 made it part of the primary key and 0020's
-- DROP CONSTRAINT left the NOT NULL behind — so plain equality is enough and
-- "WHERE id = NULL" can never silently match nothing.
--
-- The UPDATE against "games" during a cascade delete matches zero rows: the
-- game is already gone by the time its votes are removed, so the counters it
-- carried go with it. That is correct rather than merely harmless, and it is
-- why nothing here raises when a row is not found.
--
-- AFTER, not BEFORE: the totals must reflect what was actually written,
-- including a write some other BEFORE trigger might have changed. RETURN NULL
-- because the return value of an AFTER FOR EACH ROW trigger is ignored.
CREATE FUNCTION "sync_games_rating_totals"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."rating" = OLD."rating" AND NEW."gameId" = OLD."gameId" THEN
      RETURN NULL;
    END IF;

    IF NEW."gameId" = OLD."gameId" THEN
      UPDATE "games"
         SET "ratingSum" = "ratingSum" + NEW."rating" - OLD."rating"
       WHERE "id" = NEW."gameId";

      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    UPDATE "games"
       SET "ratingSum" = "ratingSum" - OLD."rating",
           "ratingCount" = "ratingCount" - 1
     WHERE "id" = OLD."gameId";
  END IF;

  IF TG_OP <> 'DELETE' THEN
    UPDATE "games"
       SET "ratingSum" = "ratingSum" + NEW."rating",
           "ratingCount" = "ratingCount" + 1
     WHERE "id" = NEW."gameId";
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER "ratings_sync_games_rating_totals"
  AFTER INSERT OR UPDATE OR DELETE ON "ratings"
  FOR EACH ROW EXECUTE FUNCTION "sync_games_rating_totals"();

-- No index for the ranking, and that is a decision rather than an omission.
--
-- The ordering the rewritten find() and findTopRated will ask for is
--
--   ORDER BY ("ratingSum" + 5 * :siteMean) / ("ratingCount" + 5) DESC, "id" DESC
--
-- and :siteMean is AVG over the whole "ratings" table — a value that changes
-- with every vote cast anywhere on the site. An expression index has to be
-- built on an IMMUTABLE expression of the row alone, so this one cannot be
-- indexed: any index storing today's mean would be silently wrong tomorrow,
-- and Postgres refuses to build it at all.
--
-- What the columns buy is therefore not an index scan but a much smaller
-- scan. The plan goes from "sequential scan of games + sequential scan of
-- ratings + hash join + HashAggregate over every group + top-N sort" to
-- "sequential scan of games + top-N sort", with no join, no GROUP BY and no
-- second table read. That is the acceptable floor here: a full-table scan of
-- "games" alone is cheap and, crucially, stops growing with the number of
-- votes — which is the term that actually grows on this site.
--
-- ("ratingCount" DESC, "id") was considered and not added. Nothing orders or
-- filters on the count: the ranking sorts on the weighted expression above,
-- and the "has any votes" test that findTopRated and loadFeaturedPool make
-- with an INNER JOIN today becomes "ratingCount" > 0, which is not selective
-- enough on a catalogue where most games have been voted on to beat the scan
-- the sort needs anyway. An index that serves no query is two things: another
-- index to write on every vote, and a line here claiming a benefit that
-- EXPLAIN would not show.
