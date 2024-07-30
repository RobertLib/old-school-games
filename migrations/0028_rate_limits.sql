-- Rate limits were counted in the memory of whichever process handled the
-- request, so every limit applied once per machine rather than once for the
-- app. On a single machine that is the same number; on two it silently
-- doubles every budget, including the ones guarding login attempts and
-- comment posting.
--
-- "key" carries the limiter's own prefix (see utils/rate-limit-store.ts), so
-- the login and comment budgets share this table without sharing counters.
CREATE TABLE IF NOT EXISTS "rate_limits" (
  "key" TEXT PRIMARY KEY,
  "hits" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMPTZ NOT NULL
);

-- For the periodic sweep of windows that have run out.
CREATE INDEX IF NOT EXISTS "idx_rate_limits_expiresAt"
  ON "rate_limits" ("expiresAt");
