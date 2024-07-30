CREATE TABLE "ratings" (
  PRIMARY KEY ("gameId", "ipAddress"),
  "ipAddress" VARCHAR(45) NOT NULL,
  "rating" INTEGER NOT NULL CHECK ("rating" >= 1 AND "rating" <= 5),
  "gameId" INTEGER REFERENCES "games" ("id") ON DELETE CASCADE
);
