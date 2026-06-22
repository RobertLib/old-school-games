ALTER TABLE "news" ADD COLUMN "slug" VARCHAR(255);

UPDATE "news"
SET "slug" = REGEXP_REPLACE(
  REGEXP_REPLACE(
    REGEXP_REPLACE(LOWER("title"), '[^a-z0-9]', '-', 'g'),
    '-+', '-', 'g'
  ),
  '^-|-$', '', 'g'
);

ALTER TABLE "news" ALTER COLUMN "slug" SET NOT NULL;
ALTER TABLE "news" ADD CONSTRAINT "news_slug_unique" UNIQUE ("slug");
