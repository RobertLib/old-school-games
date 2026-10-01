-- 0054's backfill, once more, so that every database ends up in the state the
-- current text of 0054 describes, whichever text of it that database ran.
--
-- 0054_slug_history_triggers.sql was edited after at least one database had
-- applied it: the test database recorded checksum 859684a4… on 2026-09-23,
-- and the file now hashes to 1538dd5a…. The functions and triggers it creates
-- were compared between a database that ran the earlier text and one that ran
-- the current one (pg_get_functiondef, pg_get_triggerdef) and are identical.
-- The earlier text itself is not in the history, though, so its backfill
-- cannot be compared — and a backfill that missed a live slug is exactly the
-- state 0054 was written to end: resolveSlug calls the slug free, a create or
-- a rename tries it, and the admin gets a 500.
--
-- Running it again settles that without knowing. It only adds a live slug that
-- is missing from its history, ON CONFLICT DO NOTHING, so on a database that
-- ran the current 0054 — or any database the triggers have been keeping since
-- — it inserts nothing. Soft-deleted articles included, for the reason 0053
-- gives: a hidden article still holds its slug against a live one.
--
-- A database that recorded the earlier checksum still has to have it updated
-- by hand before the runner goes on (see verifyAppliedMigrations in
-- utils/migrations.ts); this file is what makes that update safe to make.
INSERT INTO "game_slugs" ("gameId", "slug")
SELECT "id", "slug" FROM "games"
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "news_slugs" ("newsId", "slug")
SELECT "id", "slug" FROM "news"
ON CONFLICT ("slug") DO NOTHING;
