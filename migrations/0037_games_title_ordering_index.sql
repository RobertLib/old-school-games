-- Replaces "idx_title" (0001) with the index the title *ordering* actually
-- wants.
--
-- The plain btree on ("title") answers no predicate on this site: the searches
-- match with ILIKE and pg_trgm's "%" — served by "idx_games_title_trgm" (0020)
-- — the exact-title relevance test compares LOWER("title"), which needs the
-- functional "idx_games_title_lower" (0027), and the letter pages match a
-- prefix case-insensitively, which a case-sensitive btree cannot serve either.
--
-- What it does answer, now that Game.find pages the games before it joins the
-- ratings on (see models/game.ts), is the *sort*: "title" then "id" ascending
-- is the default ordering for the letter, year, developer and publisher pages.
-- Under the old shape that sort happened above a full aggregate of the
-- catalogue, so no index on "games" could ever have served it; under the new
-- one the page is a LIMIT over "games" alone, and the ordering columns are the
-- game's own.
--
-- ("title", "id") rather than ("title"), because the tie-break is part of the
-- ordering: with the leading column alone Postgres reads the index and then
-- incrementally sorts each group of equal titles, and with both it is an index
-- only scan of exactly the page. A btree reads backwards, so the descending
-- direction is served by the same index. Verified with EXPLAIN on a
-- twenty-thousand-row catalogue: sequential scan plus a top-N sort of every
-- game (424 buffers) before, index only scan of 25 rows (13) after.
DROP INDEX IF EXISTS "idx_title";

CREATE INDEX "idx_games_title_id" ON "games" ("title", "id");
