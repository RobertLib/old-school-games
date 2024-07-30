CREATE TABLE "game_of_the_week" (
  "id" SERIAL PRIMARY KEY,
  "gameId" INTEGER NOT NULL REFERENCES "games" ("id") ON DELETE CASCADE,
  "startDate" TIMESTAMP NOT NULL DEFAULT NOW(),
  "endDate" TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX "idx_game_of_the_week_dates" ON "game_of_the_week" ("startDate", "endDate");
