-- "games", "users" and "comments" have carried a "deletedAt" column since the
-- first migration, but nothing has ever read or written it: Game.delete and
-- Comment.delete issue a real DELETE, and no query filters on it. Only "news"
-- actually soft-deletes, and that one keeps its column.
--
-- An always-NULL column that looks functional is a trap. Setting it by hand —
-- reasonable, since it is exactly how news works — hides nothing at all: the
-- game or comment stays fully visible on the site.
--
-- The guard comes first. If any row somewhere did get a value, dropping the
-- column would destroy it silently, so the migration aborts instead and the
-- deploy fails loudly with something actionable.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "games" WHERE "deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "users" WHERE "deletedAt" IS NOT NULL)
    OR EXISTS (SELECT 1 FROM "comments" WHERE "deletedAt" IS NOT NULL)
  THEN
    RAISE EXCEPTION
      'deletedAt holds values on games, users or comments, but nothing in the application reads it. Decide what those rows mean before this column is dropped.';
  END IF;
END $$;

ALTER TABLE "games" DROP COLUMN "deletedAt";
ALTER TABLE "users" DROP COLUMN "deletedAt";
ALTER TABLE "comments" DROP COLUMN "deletedAt";
