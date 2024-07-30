-- /games/my-ratings asks "every rating this browser has cast" on virtually
-- every page view, and the only index covering "ratings" for that was
-- "idx_ratings_game_voter" on ("gameId", "voterId"). A lookup by "voterId"
-- alone cannot use an index whose leading column is something else, so each
-- one was a sequential scan of the whole table.
CREATE INDEX IF NOT EXISTS "idx_ratings_voterId" ON "ratings" ("voterId");
