-- Comments were sanitized on the way in and escaped again on the way out.
--
-- validations/comments.ts ran every comment through DOMPurify before storing
-- it, which turns "<" into "&lt;". Every view then renders the comment with
-- EJS's escaping <%= %>, which turns that "&" into "&amp;" — so the browser
-- received "&amp;lt;3" and showed the reader the literal text "&lt;3".
--
-- The validator no longer sanitizes; escaping at render is what makes a
-- comment safe to display, and doing it once is enough. This undoes the extra
-- escaping on the rows written while it was happening.
--
-- Only "&lt;" and "&gt;" are reversed. DOMPurify left a bare "&" alone, so a
-- stored "&amp;" is one the writer actually typed and still renders as
-- "&amp;" — reversing it would corrupt their text rather than repair it.
-- Tags that survived sanitizing ("<b>") are left as they are: they displayed
-- as literal text before this change and still do.

UPDATE "comments"
SET "content" = REPLACE(REPLACE("content", '&lt;', '<'), '&gt;', '>')
WHERE "content" LIKE '%&lt;%' OR "content" LIKE '%&gt;%';

UPDATE "comments"
SET "nick" = REPLACE(REPLACE("nick", '&lt;', '<'), '&gt;', '>')
WHERE "nick" LIKE '%&lt;%' OR "nick" LIKE '%&gt;%';
