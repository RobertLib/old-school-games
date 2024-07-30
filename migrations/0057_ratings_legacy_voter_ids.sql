-- The last copies of voters' IP addresses in "ratings", taken out.
--
-- 0020 moved deduplication from the address to a per-browser voter id, and
-- gave every vote that already existed a voter id made *of* the address:
-- 'ip:' || "ipAddress". Game.pruneRatingIps (models/game.ts) has since cleared
-- "ipAddress" on every vote older than RATING_IP_RETENTION_DAYS, which is what
-- the privacy policy promises — "we also store the IP address of that vote
-- for abuse prevention, and delete it again after 90 days" — but nothing ever
-- looked at "voterId". So every vote cast before 0020 still carries its
-- voter's address there, and will for as long as the game is listed.
--
-- Nothing reads those ids as addresses, or at all. middlewares/voter-id.ts
-- only ever hands out a v4 UUID and refuses any other cookie value, so no
-- browser can present 'ip:…' and no lookup by voter (getVoterRating,
-- getVoterRatings) can match one. The value only has to stay what it already
-- is to the unique index on ("gameId", "voterId"): distinct within a game.
-- 'legacy:' || "id" is distinct across the whole table, holds nothing about
-- the voter, and fits the column's 64 characters.
--
-- Two legacy votes from one address on two games used to share a voter id and
-- now do not. Nothing counts distinct voters, and no browser can be that
-- voter, so nothing that was true about them stops being true.
--
-- The rating totals are untouched: the 0042 trigger fires on this UPDATE, sees
-- the same "rating" and the same "gameId", and returns before it writes
-- anything to "games".
UPDATE "ratings"
SET "voterId" = 'legacy:' || "id"
WHERE "voterId" LIKE 'ip:%';
