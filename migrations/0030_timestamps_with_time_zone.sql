-- Every timestamp column in this schema was declared "TIMESTAMP", which in
-- Postgres means *without* a time zone: a wall-clock reading with no record of
-- which clock it was read from. "expiresAt" on "rate_limits" is the only one
-- that was ever declared TIMESTAMPTZ, and it is the only one that has been
-- unambiguous.
--
-- Two separate conversions were papering over the gap, and both depend on
-- settings nothing in this repository pins:
--
--   * On the way in, "DEFAULT NOW()" returns a timestamptz and the column
--     stores a timestamp, so Postgres discards the zone using the *session's*
--     TimeZone. What lands in the row is whatever wall clock the database
--     happened to be set to.
--   * On the way out, node-postgres parses a zoneless timestamp into a JS Date
--     using the *Node process's* local zone — a completely unrelated setting.
--
-- They cancel out only while the two agree. Today they do: Supabase runs UTC
-- and the container leaves TZ unset, which Node also reads as UTC. Nothing
-- states that anywhere, and nothing would notice if it changed. Reading one
-- row back through both zones shows the size of it:
--
--   process TZ            : Europe/Prague      TZ=UTC
--   TIMESTAMP   -> JS Date: 15:26:07.462Z      17:26:07.462Z   <- same row
--   TIMESTAMPTZ -> JS Date: 15:26:07.462Z      15:26:07.462Z
--
-- Two hours, silently, on every value the site publishes as an absolute
-- instant: <pubDate> in both RSS feeds, datePublished and dateModified in the
-- JSON-LD, <lastmod> in every sitemap chunk, and the <time> elements on the
-- pages. A timestamptz column has no such dependency — it stores an instant,
-- and both ends agree on what it means.
--
-- The USING clauses name UTC explicitly rather than leaning on the session, so
-- this migration converts the same way whoever runs it and wherever from. That
-- is correct because UTC is the clock the existing rows were written against.
SET TIME ZONE 'UTC';

ALTER TABLE "games"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "users"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';

ALTER TABLE "comments"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';

-- "deletedAt" is the nullable one; AT TIME ZONE leaves a NULL alone.
ALTER TABLE "news"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "deletedAt" TYPE TIMESTAMPTZ USING "deletedAt" AT TIME ZONE 'UTC';

-- "startDate" and "endDate" are compared against NOW() on every page view
-- (GameOfTheWeek.getCurrent), which is the one place the mismatch could have
-- picked the wrong week outright rather than merely reporting a shifted time.
ALTER TABLE "game_of_the_week"
  ALTER COLUMN "startDate" TYPE TIMESTAMPTZ USING "startDate" AT TIME ZONE 'UTC',
  ALTER COLUMN "endDate" TYPE TIMESTAMPTZ USING "endDate" AT TIME ZONE 'UTC',
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC',
  ALTER COLUMN "updatedAt" TYPE TIMESTAMPTZ USING "updatedAt" AT TIME ZONE 'UTC';

-- Compared against NOW() by prunePlays, so the retention window was measured
-- against the same ambiguous clock.
ALTER TABLE "plays"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "game_slugs"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC';

ALTER TABLE "news_slugs"
  ALTER COLUMN "createdAt" TYPE TIMESTAMPTZ USING "createdAt" AT TIME ZONE 'UTC';

-- Added to this file after it had already been applied, which is why
-- 0032_migrations_timestamp_with_time_zone.sql exists as well: a runner runs a
-- file once, so a database that had already recorded 0030 would never have
-- seen this line. 0032 is that database's copy of it, and a no-op for one
-- created since. Nothing else in this file was changed after the fact.
ALTER TABLE "migrations"
  ALTER COLUMN "appliedAt" TYPE TIMESTAMPTZ USING "appliedAt" AT TIME ZONE 'UTC';

-- connect-pg-simple's own table, and the precision is kept: it writes with
-- to_timestamp(), which already returns a timestamptz, and expires rows with a
-- plain "expire < NOW()". Both read correctly against either type, so this is
-- the one conversion that fixes no live comparison — it is here so that no
-- zoneless timestamp is left in the schema to be copied from later.
ALTER TABLE "session"
  ALTER COLUMN "expire" TYPE TIMESTAMPTZ(6) USING "expire" AT TIME ZONE 'UTC';
