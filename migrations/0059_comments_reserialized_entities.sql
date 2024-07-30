-- The other half of 0023, which reversed only part of what sanitizing did.
--
-- 0023 assumed DOMPurify "left a bare & alone". It does, but only for a
-- comment with no "<" in it: that is DOMPurify's fast path, which hands such
-- input back exactly as it came. Anything with a "<" is parsed and
-- re-serialised, and serialising escapes "&" to "&amp;" and U+00A0 to
-- "&nbsp;" as well as "<" and ">". 0023 put "<" and ">" back and left the
-- rest, so "<3 Tom & Jerry", stored as "&lt;3 Tom &amp; Jerry", still shows
-- every reader "<3 Tom &amp; Jerry".
--
-- Which rows: the ones with a "<" in them now, created before 0023 was
-- applied.
--
--   - A "<" marks the re-serialising path. 0023 decoded every "&lt;", and a
--     tag that survived sanitizing was stored as it was written, so every
--     comment that went through that path has one — and one that did not
--     has none, and its "&amp;" is what its writer typed.
--   - Before 0023, because that is when sanitizing stopped: the validator
--     change and 0023 shipped together, and the release command applies a
--     migration before any machine runs the code beside it. After it, a "<"
--     with "&amp;" next to it is exactly what somebody wrote. A database with
--     no record of 0023 compares against NULL and matches nothing, which is
--     the safe answer.
--
-- "&nbsp;" first, then "&amp;". The other order would turn a typed "&nbsp;"
-- — stored as "&amp;nbsp;" — into a no-break space rather than back into
-- the six characters its writer typed.
--
-- Not repairable here: a comment with no "<" in which someone typed "&lt;"
-- was stored as typed, and 0023 turned it into "<". Nothing in the row says
-- which ones those were.

UPDATE "comments"
SET "content" = REPLACE(REPLACE("content", '&nbsp;', chr(160)), '&amp;', '&')
WHERE "content" LIKE '%<%'
  AND ("content" LIKE '%&amp;%' OR "content" LIKE '%&nbsp;%')
  AND "createdAt" < (
    SELECT "appliedAt" FROM "migrations"
    WHERE "name" = '0023_unescape_comment_entities.sql'
  );

UPDATE "comments"
SET "nick" = REPLACE(REPLACE("nick", '&nbsp;', chr(160)), '&amp;', '&')
WHERE "nick" LIKE '%<%'
  AND ("nick" LIKE '%&amp;%' OR "nick" LIKE '%&nbsp;%')
  AND "createdAt" < (
    SELECT "appliedAt" FROM "migrations"
    WHERE "name" = '0023_unescape_comment_entities.sql'
  );
