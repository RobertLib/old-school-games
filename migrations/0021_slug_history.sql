-- Slugs used to be recomputed from the title on every save and written in
-- place. Renaming a game therefore silently broke its URL: the old address
-- 404'd, and the search ranking it had accumulated went with it. Two games
-- sharing a title were worse still — the UNIQUE constraint turned the second
-- save into a 500.
--
-- Every slug an item has ever had is kept here, including the current one, so
-- the old address can 301 to the new one and so a new slug can be checked for
-- collisions against history rather than only against what is live today.

CREATE TABLE "game_slugs" (
  "id" SERIAL PRIMARY KEY,
  "gameId" INTEGER NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  "slug" VARCHAR(255) NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_game_slugs_gameId" ON "game_slugs" ("gameId");

INSERT INTO "game_slugs" ("gameId", "slug")
SELECT "id", "slug" FROM "games" WHERE "slug" IS NOT NULL;

CREATE TABLE "news_slugs" (
  "id" SERIAL PRIMARY KEY,
  "newsId" INTEGER NOT NULL REFERENCES "news" ("id") ON DELETE CASCADE,
  "slug" VARCHAR(255) NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_news_slugs_newsId" ON "news_slugs" ("newsId");

INSERT INTO "news_slugs" ("newsId", "slug")
SELECT "id", "slug" FROM "news" WHERE "slug" IS NOT NULL;
