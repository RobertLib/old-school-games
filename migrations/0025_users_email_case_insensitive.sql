-- Logging in was case-sensitive: User.findByEmail compared the column
-- directly, so an account seeded as "admin@example.com" could not be reached
-- by typing "Admin@example.com". The lookup now folds case, and this index
-- both keeps it off a sequential scan and stops two accounts existing that
-- differ only in case — which folding the lookup would otherwise make
-- ambiguous.
--
-- If this fails on a duplicate, two such accounts already exist and have to
-- be merged by hand; the deploy stopping is the right outcome.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key"
  ON "users" (LOWER("email"));
