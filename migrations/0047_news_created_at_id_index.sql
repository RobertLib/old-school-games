-- The index the article listings actually ask for, replacing the one from
-- 0015 that answers half of the question.
--
-- Every query in models/news.ts that orders articles does it the same way:
--
--   SELECT * FROM "news"
--   WHERE "deletedAt" IS NULL
--   ORDER BY "createdAt" DESC, "id" DESC
--
-- — findAll for the paged /news page, findRecent for the sidebar widget and
-- the feed. "idx_news_created_at" ("createdAt" DESC, 0015) leads with the
-- right column and then stops, so Postgres reads the index, filters the
-- soft-deleted rows out by hand and incrementally sorts each group of equal
-- "createdAt" values — and equal values are not rare here: a seeded batch of
-- articles shares one, which is exactly why "id" is in the ORDER BY (see the
-- comment on findAll).
--
-- With both columns and the predicate the page is an index scan of the rows
-- it returns. A btree reads backwards, so the ascending direction comes free.
--
-- Partial on "deletedAt" IS NULL because every single query against this
-- table carries that predicate — findAll, findRecent, findById, findBySlug,
-- findCurrentSlug, the counts, the update and the soft delete itself. Nothing
-- reads a deleted article, so nothing needs it in the index, and keeping it
-- out is what lets the planner satisfy the whole WHERE clause from the index.
CREATE INDEX "idx_news_created_at_id"
  ON "news" ("createdAt" DESC, "id" DESC)
  WHERE "deletedAt" IS NULL;

-- Dropped rather than kept: it is a strict prefix of the new index on the
-- only rows anything looks at. The one thing a non-partial index could still
-- serve is an ordering over deleted articles too, and there is no such query
-- — the admin listing at /news is findAll, which filters like the rest. If
-- one is ever added it will want its own index anyway, because it will want
-- the "id" tie-break this one does not have either.
DROP INDEX IF EXISTS "idx_news_created_at";
