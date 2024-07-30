-- The previous/next links on every game page find their neighbour in title
-- order, and nothing could serve that search.
--
-- Game.findAdjacentGames asked for it with an OR — "LOWER(title) < x OR
-- (LOWER(title) = x AND id < y)" — on the belief, written down beside it, that
-- "idx_games_title_lower" (0027) would serve the first branch. It did not: an
-- OR of two ranges is not an index condition, so Postgres used that index only
-- for its order, started at the far end and filtered row by row until it met
-- the neighbour. About half the catalogue per query, and there are two queries
-- on every uncached game page: ~17k buffers and ~5ms each on 20k games, growing
-- linearly with the catalogue.
--
-- The query is a row comparison now, "(LOWER(title), id) < (LOWER(x), y)",
-- and a row comparison whose columns are an index's leading columns *is* an
-- index condition. This is that index. The neighbour is then the first entry
-- on either side of the position: three buffers, whatever the catalogue size.
--
-- The expression is written as 0027 and 0049 write it, so the three are built
-- on the same lower("title"::text).
CREATE INDEX "idx_games_title_lower_id"
  ON "games" (LOWER("title"), "id");

-- And 0027's single-column index goes, because this one begins with the same
-- expression under the same collation: every equality, range or ordering on
-- LOWER("title") that could use the old one can use this, so keeping both is
-- one more index to maintain on every write for no read it alone serves. The
-- comment in 0049 that sends ordering on LOWER("title") to "idx_games_title_
-- lower" is describing this index from here on — 0049 has been applied and is
-- not edited.
DROP INDEX IF EXISTS "idx_games_title_lower";
