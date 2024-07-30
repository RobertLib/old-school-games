-- Fuzzy search: trigram matching so typos and partial names still find games,
-- and so developer/publisher names are searchable too.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX "idx_games_title_trgm" ON "games" USING GIN ("title" gin_trgm_ops);
CREATE INDEX "idx_games_developer_trgm" ON "games" USING GIN ("developer" gin_trgm_ops);
CREATE INDEX "idx_games_publisher_trgm" ON "games" USING GIN ("publisher" gin_trgm_ops);

-- Threaded comments: replies point at the comment they answer.
ALTER TABLE "comments"
  ADD COLUMN "parentId" INTEGER REFERENCES "comments" ("id") ON DELETE CASCADE;

CREATE INDEX "idx_comments_parentId" ON "comments" ("parentId");
CREATE INDEX "idx_comments_gameId" ON "comments" ("gameId");

-- Ratings were deduplicated by IP address, so everyone behind the same NAT
-- (mobile networks, offices) overwrote each other's vote. Switch to a
-- per-browser voter id; keep the IP only for abuse investigation.
ALTER TABLE "ratings" ADD COLUMN "voterId" VARCHAR(64);

UPDATE "ratings" SET "voterId" = 'ip:' || "ipAddress" WHERE "voterId" IS NULL;

ALTER TABLE "ratings" DROP CONSTRAINT "ratings_pkey";
ALTER TABLE "ratings" ADD COLUMN "id" SERIAL PRIMARY KEY;
ALTER TABLE "ratings" ALTER COLUMN "ipAddress" DROP NOT NULL;
ALTER TABLE "ratings" ALTER COLUMN "voterId" SET NOT NULL;

CREATE UNIQUE INDEX "idx_ratings_game_voter" ON "ratings" ("gameId", "voterId");
