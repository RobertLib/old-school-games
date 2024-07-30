-- Every live slug in its own history, kept there by the database rather than
-- by whichever code happened to write the row.
--
-- resolveSlug (utils/slug.ts) decides which slugs are taken by asking the
-- history tables alone — "game_slugs" and "news_slugs" (0021) — because an
-- address an entity has given up still redirects to it and must not be handed
-- to anybody else. That is only right while the history holds every live slug
-- as well, and nothing made sure it did: the models record a slug in the same
-- statement that makes it current, and a row written any other way — inserted
-- by hand, imported with SQL, its slug corrected in psql — had a live slug
-- the history had never seen. resolveSlug then called that slug free. So with
-- a hand-inserted ('Quake', 'quake') in "games", creating "Quake" through the
-- admin, or renaming any game to it, tried "quake", hit "games_slug_key", and
-- withResolvedSlug re-resolved the very same answer four more times before
-- giving up: the 500 page, with the admin's form gone. News had the same path.
--
-- 0053 backfilled the history once and Game.update and News.update learned to
-- record the outgoing slug on a rename, which covered the rows that existed on
-- the day and the rename of one written since — but not a create, or a
-- rename *onto*, a slug such a row holds, and every new hand-written row
-- opened the gap again. A trigger closes it for every writer at once: whatever
-- inserts a row or sets its slug, the slug is in the history by the time the
-- statement is over. That makes the outgoing-slug write 0053 describes
-- redundant — the slug being renamed away from is always recorded already —
-- and Game.update no longer makes it; its comment says why.
--
-- AFTER, and FOR EACH ROW, and the models' own history writes are kept. Both
-- models write the slug from a data-modifying CTE in the same statement as the
-- row, and an AFTER trigger fires only once the *whole* statement has run —
-- CTEs included — so by then the model's row is already there and ON CONFLICT
-- turns the trigger's copy into nothing. The first slug an entity ever had is
-- therefore still the lowest id in its history, which is what findFirstSlugs
-- and the feed guid built from it depend on. For a row written any other way,
-- the trigger's row *is* the first one.
--
-- ON CONFLICT ("slug") DO NOTHING rather than an error, for the same reason
-- the models use it: the slug is UNIQUE across a history table and is usually
-- there already — every save through a model rewrites "slug", which is what
-- UPDATE OF "slug" fires on, whether or not the value changed.
--
-- It is also what a hand-written row runs into when it takes a slug some
-- *other* entity has retired. The history row stays with that other entity,
-- so the slug is still in the history and still refused to every new save —
-- with one exception this does not cover: the entity the history row belongs
-- to reads the slug as its own, and renaming it back onto that old title
-- collides with the hand-written row as before. No model can produce that
-- state (resolveSlug never hands out a slug another entity has held), so it
-- takes a hand-written row choosing an address that already redirects
-- somewhere else, and refusing that row outright would turn a data-entry
-- slip into a failed import.
--
-- Which also means a later migration that moves a slug, as 0045 did, has no
-- history row of its own to write any more — and one that writes it the way
-- 0045 did, with a plain INSERT, fails on the row the trigger has just made.
--
-- The return value of an AFTER FOR EACH ROW trigger is ignored, hence NULL,
-- as in 0042.
CREATE FUNCTION "record_game_slug_history"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "game_slugs" ("gameId", "slug")
  VALUES (NEW."id", NEW."slug")
  ON CONFLICT ("slug") DO NOTHING;

  RETURN NULL;
END;
$$;

CREATE FUNCTION "record_news_slug_history"() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "news_slugs" ("newsId", "slug")
  VALUES (NEW."id", NEW."slug")
  ON CONFLICT ("slug") DO NOTHING;

  RETURN NULL;
END;
$$;

-- Installed before the backfill below, not after, and that order is what
-- leaves no window. CREATE TRIGGER takes SHARE ROW EXCLUSIVE on its table and
-- holds it until this migration commits, which waits out every write already
-- in flight and makes every later one queue behind the lock — and a write
-- that queued fires the trigger when it finally runs. The backfill's snapshot
-- is then taken with nothing left unaccounted for between the two. The other
-- order has the gap 0052 was written to repair for 0042: a row inserted after
-- the backfill read the table and before the trigger existed is recorded by
-- neither. Reads carry on throughout; only writes to "games" and "news" wait,
-- and only for the length of this file.
CREATE TRIGGER "games_record_slug_history"
  AFTER INSERT OR UPDATE OF "slug" ON "games"
  FOR EACH ROW EXECUTE FUNCTION "record_game_slug_history"();

CREATE TRIGGER "news_record_slug_history"
  AFTER INSERT OR UPDATE OF "slug" ON "news"
  FOR EACH ROW EXECUTE FUNCTION "record_news_slug_history"();

-- The rows written since 0053 without going through a model: 0053's backfill
-- again, for the last time, because nothing can reach that state once the
-- triggers exist. Soft-deleted articles included, for the reason 0053 gives —
-- a hidden article still holds its slug against a live one. A row that
-- already has history keeps its first slug first: this only adds a live slug
-- that is missing, at an id above everything recorded before it.
INSERT INTO "game_slugs" ("gameId", "slug")
SELECT "id", "slug" FROM "games"
ON CONFLICT ("slug") DO NOTHING;

INSERT INTO "news_slugs" ("newsId", "slug")
SELECT "id", "slug" FROM "news"
ON CONFLICT ("slug") DO NOTHING;
