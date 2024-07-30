-- Recomputes the rating totals 0042 put on "games", once, under a lock that
-- 0042 did not take.
--
-- 0042 backfilled "ratingSum" and "ratingCount" from the ratings table and then
-- installed the trigger that keeps them exact. Between the two there was a
-- window it did not close. It locked "games", but a *changed* vote is the
-- upsert's DO UPDATE path on "ratings", which takes no lock on "games" at all —
-- so a vote changed after the backfill's snapshot and before CREATE TRIGGER was
-- counted by neither: the backfill saw the old value, and the trigger did not
-- exist yet to apply the difference. Replayed on two connections, that left a
-- game at ratingSum 1 while SUM(rating) was 5 — a value the CHECK constraint
-- accepts, so nothing would ever have noticed, and the trigger only ever adds
-- deltas to whatever it finds.
--
-- SHARE mode blocks every write to "ratings" (they take ROW EXCLUSIVE) until
-- this commits, and nothing else: the site keeps reading ratings, and a vote
-- cast meanwhile waits a moment rather than landing half inside the
-- recomputation. The trigger is already installed, so every vote after this
-- commits is counted by it as before.
--
-- Only rows that actually disagree are written. On a database where 0042's
-- window caught nothing this updates nothing, and a game whose totals were
-- right keeps its row untouched.
LOCK TABLE "ratings" IN SHARE MODE;

UPDATE "games" g
SET "ratingSum" = t."sum",
    "ratingCount" = t."count"
FROM (
  SELECT g2."id",
         COALESCE(SUM(r."rating"), 0) AS "sum",
         COUNT(r."id") AS "count"
  FROM "games" g2
  LEFT JOIN "ratings" r ON r."gameId" = g2."id"
  GROUP BY g2."id"
) t
WHERE t."id" = g."id"
  AND (g."ratingSum" <> t."sum" OR g."ratingCount" <> t."count");
