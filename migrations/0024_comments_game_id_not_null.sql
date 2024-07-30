-- "comments"."gameId" has been nullable since the first migration, but a
-- comment that belongs to no game is not something the application can
-- represent: it is unreachable from the game page that would render it, and
-- the site-wide overview and sidebar widget both reach it through a JOIN on
-- "games", so it would silently never appear anywhere.
--
-- Comment.create always supplies the id and validateComment refuses a request
-- without one, so the constraint is only catching up with the invariant the
-- code already keeps.
--
-- Orphans are deleted rather than aborting the migration, which is what
-- 0022 does for a column whose meaning was unclear. Here it is not unclear:
-- the row is invisible on the site and there is no game to attach it back to.
DELETE FROM "comments" WHERE "gameId" IS NULL;

ALTER TABLE "comments" ALTER COLUMN "gameId" SET NOT NULL;
