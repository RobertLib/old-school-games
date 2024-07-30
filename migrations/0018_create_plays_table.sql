CREATE TABLE "plays" (
  "id" SERIAL PRIMARY KEY,
  "gameId" INTEGER NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_plays_gameId" ON "plays" ("gameId");
CREATE INDEX "idx_plays_createdAt" ON "plays" ("createdAt");
