CREATE TABLE "news" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMP,
  "title" VARCHAR(255) NOT NULL,
  "content" TEXT NOT NULL,
  "userId" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX "idx_news_created_at" ON "news" ("createdAt" DESC);
