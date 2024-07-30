CREATE TABLE "session" (
  "sid" VARCHAR NOT NULL COLLATE "default",
  "sess" JSON NOT NULL,
  "expire" TIMESTAMP(6) NOT NULL
)
WITH (OIDS=FALSE);

ALTER TABLE "session" ADD CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX "IDX_session_expire" ON "session" ("expire");

CREATE EXTENSION unaccent;

CREATE TYPE USER_ROLE AS ENUM ('USER', 'ADMIN');

CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMP,
  "email" VARCHAR(255) NOT NULL UNIQUE,
  "password" VARCHAR(255) NOT NULL,
  "role" USER_ROLE NOT NULL DEFAULT 'USER'
);

CREATE TABLE "games" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMP,
  "title" VARCHAR(255) NOT NULL,
  "description" TEXT,
  "stream" TEXT,
  "userId" INTEGER REFERENCES "users" ("id") ON DELETE SET NULL
);

CREATE INDEX "idx_title" ON "games" ("title");

CREATE TABLE "comments" (
  "id" SERIAL PRIMARY KEY,
  "createdAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMP NOT NULL DEFAULT NOW(),
  "deletedAt" TIMESTAMP,
  "content" TEXT NOT NULL,
  "gameId" INTEGER REFERENCES "games" ("id") ON DELETE CASCADE
);
