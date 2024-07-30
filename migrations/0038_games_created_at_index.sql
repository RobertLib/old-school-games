-- Game.find pages the "createdAt" ordering with LIMIT/OFFSET now instead of
-- aggregating the whole catalogue first (see models/game.ts), and an
-- index-ordered scan is what makes that paging cheap: without one, "newest
-- first" is a sequential scan plus a sort of every game on every request, and
-- it is the default ordering for the sidebar's "Recently added" widget as well
-- as for "?orderBy=createdAt".
--
-- Descending with "id" as the tie-break, because that is the order the query
-- asks for and the order the feed uses — games imported in one batch share a
-- "createdAt", so "id" is what keeps the page boundary stable. A btree can be
-- read backwards, so the ascending direction is served by the same index.
CREATE INDEX "idx_games_created_at_id"
  ON "games" ("createdAt" DESC, "id" DESC);
