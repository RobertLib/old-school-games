-- "idx_games_slug" (0014) duplicates "games_slug_key", the index the UNIQUE
-- constraint from 0008 already maintains on the same column. Two identical
-- indexes cost every write twice and help no read. 0029 removed the same kind
-- of duplicate on "ratings".
DROP INDEX IF EXISTS "idx_games_slug";
