import { describe, expect, it } from "vitest";
import { META_DESCRIPTION_MAX, TITLE_MAX } from "../../utils/html-text.ts";
import { GENRE_DATA, STUDIO_DATA, YEAR_DATA } from "../../content/blurbs.ts";
import { LISTS } from "../../routes/lists.ts";
import { SITE_DESCRIPTION, SITE_TITLE } from "../../utils/site.ts";

/**
 * The hand-written half of the site's metadata, held to the same limits the
 * composed half is.
 *
 * Every <title> and meta description a *route* builds now passes through
 * fitTitle or paginatedDescription, which cannot go over. These do not: they
 * are literals typed into a content file or a list definition and rendered as
 * written, so the only thing keeping them inside the limit is somebody having
 * counted — and nobody had. Six of the fifteen curated lists ran between 162
 * and 189 characters against a 155 limit, and all eighteen studio titles ran
 * between 65 and 98 against a 60 one, the longest being New World Computing's
 * at 98. Google cut every one of them, and what it cuts off the end of a title
 * is the brand.
 *
 * This is the same kind of guard tests/utils/reserved-slugs.test.ts applies to
 * its hand-kept list: it does not stop anybody writing a long sentence, it
 * stops one reaching production unnoticed.
 */
describe("hand-written page metadata", () => {
  /**
   * The pair every page that names none of its own falls back to, which makes
   * an over-long one the most-served description on the site rather than the
   * least. SITE_DESCRIPTION was 158 characters.
   */
  describe("the site-wide fallbacks", () => {
    it("has a title that fits", () => {
      expect(SITE_TITLE.length).toBeLessThanOrEqual(TITLE_MAX);
    });

    it("has a description that fits", () => {
      expect(SITE_DESCRIPTION.length).toBeLessThanOrEqual(META_DESCRIPTION_MAX);
    });
  });

  describe("curated studio titles", () => {
    const entries = Object.entries(STUDIO_DATA);

    it("has entries to check", () => {
      expect(entries.length).toBeGreaterThanOrEqual(15);
    });

    it.each(entries)("%s fits in a search result", (_name, { title }) => {
      expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    });

    // Each one is the <title> of a page, so it has to end in the brand for a
    // result to be recognisable as this site's.
    it.each(entries)("%s ends in the brand", (_name, { title }) => {
      expect(title.endsWith("| OldSchoolGames")).toBe(true);
    });
  });

  describe("curated list definitions", () => {
    it("has lists to check", () => {
      expect(LISTS.length).toBeGreaterThanOrEqual(10);
    });

    it.each(LISTS.map((list) => [list.slug, list] as const))(
      "%s has a title that fits",
      (_slug, list) => {
        expect(list.title.length).toBeLessThanOrEqual(TITLE_MAX);
      },
    );

    it.each(LISTS.map((list) => [list.slug, list] as const))(
      "%s has a description that fits",
      (_slug, list) => {
        expect(list.description.length).toBeLessThanOrEqual(
          META_DESCRIPTION_MAX,
        );
      },
    );
  });

  /**
   * The blurbs are body copy rather than metadata — the pages render them as a
   * paragraph — but routes/home.ts also derives a meta description from each,
   * and it does so with truncateAtWord. So there is nothing to enforce about
   * their length; what matters is that there is something to derive from.
   */
  describe("blurbs", () => {
    const blurbs = [
      ...Object.entries(STUDIO_DATA).map(
        ([name, entry]) => [`studio ${name}`, entry.blurb] as const,
      ),
      ...Object.entries(GENRE_DATA).map(
        ([name, entry]) => [`genre ${name}`, entry.blurb] as const,
      ),
      ...Object.entries(YEAR_DATA).map(
        ([name, entry]) => [`year ${name}`, entry.blurb] as const,
      ),
    ];

    it.each(blurbs)("%s is long enough to be worth showing", (_name, blurb) => {
      expect(blurb.trim().length).toBeGreaterThan(40);
    });
  });
});
