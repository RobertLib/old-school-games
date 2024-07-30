-- findAdjacentGames compares and now also orders on LOWER("title"), which the
-- plain "idx_title" cannot serve: a functional expression needs an index on
-- the same expression. Without this, the previous/next links at the bottom of
-- every game page cost two sequential scans plus a sort.
CREATE INDEX IF NOT EXISTS "idx_games_title_lower" ON "games" (LOWER("title"));
