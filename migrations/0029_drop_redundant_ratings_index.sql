-- 0011 created an index on "ratings" ("gameId"). 0020 then added the UNIQUE
-- index on ("gameId", "voterId") that deduplicates a browser's vote, and a
-- lookup by "gameId" alone is served just as well by that index's leading
-- column — so the standalone one has been dead weight ever since: another
-- index to write on every vote and another to hold in memory, buying nothing.
--
-- Everything that reads "ratings" by game goes through the composite index
-- either way: the joins in models/game.ts, getRatingSummary and the
-- ON CONFLICT in rate(), which needs the unique one specifically.
DROP INDEX IF EXISTS "idx_ratings_game_id";
