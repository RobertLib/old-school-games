-- Every current slug in its own history, once more.
--
-- The history tables (0021) are what lets an old address 301 to a renamed game
-- or article, and the models write to them on every create and every update —
-- the new slug, recorded in the same statement that makes it current. Nothing
-- recorded a slug that did not arrive through a model. A row inserted by hand
-- or imported with SQL got a slug and no history row, and the first rename
-- through the admin then recorded only the *new* slug: the address the game had
-- been published at, linked from outside and listed in search results, went
-- from resolving to a 404 with nothing left to redirect it.
--
-- 0021 backfilled the history once, for the rows that existed then. This does
-- it again for everything since, and the models now record the outgoing slug
-- on every update as well (see Game.update and News.update), so a row that
-- skipped this step is covered the first time it is renamed.
--
-- Soft-deleted articles included: their slug was already in the history if a
-- model created them, which is what keeps it from being handed to a new
-- article while the old one might be restored, and a hand-inserted one should
-- be held the same way. ON CONFLICT because the slug is unique across a
-- history table and most of these are already there.
INSERT INTO "game_slugs" ("gameId", "slug")
SELECT "id", "slug" FROM "games"
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "news_slugs" ("newsId", "slug")
SELECT "id", "slug" FROM "news"
ON CONFLICT ("slug") DO NOTHING;
