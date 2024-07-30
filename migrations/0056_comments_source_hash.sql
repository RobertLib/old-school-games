-- Where a comment came from, recorded so that moderation can find and take
-- down everything one source posted in a single action.
--
-- Nothing tied one comment to another. They are posted without an account,
-- and the only brake was the limiter in routes/comments.ts — ten posts per
-- five minutes per address, and an IPv6 address counts by its /56, so a /48
-- is 256 budgets: some 2,560 comments in five minutes, every one of them live
-- at once in the site-wide "Latest comments" sidebar. The admin could delete
-- them one click at a time and had no way to find the rest.
--
-- A keyed hash, never the address. models/comment.ts derives it (see
-- commentSource) from the address the way the comment limiter counts it —
-- the whole of an IPv4 address, the /56 of an IPv6 one — under a key derived
-- from SESSION_SECRET for this purpose alone. It is only ever compared for
-- equality, which a hash does as well as an address, so the address is not
-- needed to do the job and a copy of this table is not a list of who posted
-- from where.
--
-- The CHECK is what keeps it a hash. A raw address written here — by a later
-- change that passed req.ip straight through, say — would be personal data
-- the privacy policy says is not stored, and nothing else would notice; the
-- database refuses it instead.
ALTER TABLE "comments"
  ADD COLUMN "sourceHash" TEXT
    CONSTRAINT "comments_sourceHash_format"
    CHECK ("sourceHash" ~ '^[0-9a-f]{64}$');

-- Existing comments get no source, and none can be made up for them: the
-- address was never recorded. They can still be deleted one at a time, as
-- before.

-- "Every comment from this source": Comment.findSameSource and
-- Comment.deleteSameSource look the hash up by the comment the admin clicked.
--
-- Partial, because a source is cleared after SOURCE_RETENTION_DAYS (see
-- Comment.pruneSources), so only the last month of comments ever carries one:
-- the index stays the size of that month rather than growing with the table,
-- and an equality lookup implies the NOT NULL, so the planner can use it.
CREATE INDEX "idx_comments_sourceHash"
  ON "comments" ("sourceHash")
  WHERE "sourceHash" IS NOT NULL;

-- What the daily prune scans for — the same shape as
-- "idx_ratings_ip_retention" (0031) and for the same reason: the sweep only
-- ever looks at rows that still carry a source, and a scrubbed row drops out
-- of the index, so a run that finds nothing costs almost nothing.
CREATE INDEX "idx_comments_source_retention"
  ON "comments" ("createdAt")
  WHERE "sourceHash" IS NOT NULL;
