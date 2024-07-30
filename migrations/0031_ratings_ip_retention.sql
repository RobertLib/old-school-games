-- "ratings" holds an IP address per vote, kept for abuse investigation (see
-- the comment in 0020). Nothing ever removed it: "plays" has a 365-day
-- retention enforced by Game.prunePlays, sessions expire, rate-limit windows
-- are swept — the one column in this schema that is personal data under GDPR
-- was the one thing kept forever, and the privacy policy's retention section
-- did not mention it at all.
--
-- The column cannot be aged out as it stands, because "ratings" is the only
-- table here with no timestamp: 0011 created it keyed by ("gameId",
-- "ipAddress") and never needed one. So the window has to be given something
-- to measure against first.
--
-- Existing rows take NOW() as their default, which dates them all to this
-- migration rather than to when they were actually cast. That is the honest
-- option available — the information to do better was never recorded — and
-- its only effect is that the IPs already stored are scrubbed one full window
-- from this deploy instead of one window from the vote.
ALTER TABLE "ratings"
  ADD COLUMN "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Partial, because the scan behind Game.pruneRatingIps only ever looks at
-- rows that still carry an address. Every scrubbed row drops straight out of
-- the index, so it stays roughly the size of one retention window's votes
-- rather than growing with the table.
CREATE INDEX "idx_ratings_ip_retention"
  ON "ratings" ("createdAt")
  WHERE "ipAddress" IS NOT NULL;
