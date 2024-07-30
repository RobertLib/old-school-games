-- resolveSlug asks for every slug that begins with a title's base — "doom" and
-- "doom-%" — so that a second game called Doom is handed "doom-2" rather than
-- failing the UNIQUE constraint. See Game.resolveSlug and News.resolveSlug.
--
-- The existing indexes on these columns ("game_slugs_slug_key" and
-- "news_slugs_slug_key", both from 0021) are built under the database's own
-- collation, which for en_US is not byte order — so Postgres cannot turn
-- "slug" LIKE 'doom-%' into a range scan on them and reads the whole table
-- instead. One sequential scan of the slug history per save today; it grows
-- with every rename the site has ever made.
--
-- text_pattern_ops indexes the same column in plain byte order, which is
-- exactly what a LIKE prefix needs. The unique indexes stay: they are what the
-- equality lookups and the constraint itself use.
CREATE INDEX "idx_game_slugs_slug_pattern"
  ON "game_slugs" ("slug" text_pattern_ops);

CREATE INDEX "idx_news_slugs_slug_pattern"
  ON "news_slugs" ("slug" text_pattern_ops);
