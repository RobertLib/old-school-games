import { describe, expect, it } from "vitest";
import {
  paginatedDescription,
  paginatedTitle,
  paginationUrls,
  parsePageParam,
  totalPages,
} from "../../utils/pagination.ts";
import { META_DESCRIPTION_MAX, TITLE_MAX } from "../../utils/html-text.ts";

describe("parsePageParam", () => {
  it("returns 1 when page is missing", () => {
    expect(parsePageParam(undefined)).toBe(1);
  });

  it("returns a valid positive integer page", () => {
    expect(parsePageParam("3")).toBe(3);
  });

  it("returns 1 for non-numeric, decimal, zero and negative values", () => {
    expect(parsePageParam("invalid")).toBe(1);
    expect(parsePageParam("1.5")).toBe(1);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-4")).toBe(1);
  });

  /**
   * Number() read all of these as real pages, so a single page answered 200
   * at endlessly many addresses. Everything else in this codebase already
   * insists on plain digits; this was the one spot that did not.
   */
  it.each([
    ["1e3", "exponent notation"],
    ["1E3", "upper-case exponent"],
    [" 5 ", "surrounding whitespace"],
    ["+5", "a leading plus"],
    ["01", "a leading zero"],
    ["5.0", "a trailing decimal"],
    ["0x10", "hexadecimal"],
    ["1_0", "a numeric separator"],
    ["", "an empty value"],
    ["Infinity", "the word Infinity"],
  ])("refuses %s (%s)", (value) => {
    expect(parsePageParam(value)).toBe(1);
  });

  // The pattern admits any run of digits, so the numeric check behind it still
  // has to catch the ones too long to be a number at all.
  it("refuses a digit run longer than a number can hold", () => {
    expect(parsePageParam("9".repeat(400))).toBe(1);
  });

  it("caps very large pages", () => {
    expect(parsePageParam("10001")).toBe(10000);
  });

  it("uses the first value when Express provides an array", () => {
    expect(parsePageParam(["2", "3"])).toBe(2);
  });
});

describe("paginationUrls", () => {
  const base = { baseUrl: "https://example.com/games", limit: 25 };

  it("addresses page 1 as the bare base URL, never as ?page=1", () => {
    const { canonicalUrl, prevPageUrl } = paginationUrls({
      ...base,
      page: 1,
      total: 100,
    });

    expect(canonicalUrl).toBe("https://example.com/games");
    expect(prevPageUrl).toBeUndefined();
  });

  it("points prev at the bare base URL from page 2", () => {
    expect(paginationUrls({ ...base, page: 2, total: 100 }).prevPageUrl).toBe(
      "https://example.com/games",
    );
  });

  it("numbers prev and next on the pages in between", () => {
    const { prevPageUrl, nextPageUrl, canonicalUrl } = paginationUrls({
      ...base,
      page: 3,
      total: 100,
    });

    expect(prevPageUrl).toBe("https://example.com/games?page=2");
    expect(canonicalUrl).toBe("https://example.com/games?page=3");
    expect(nextPageUrl).toBe("https://example.com/games?page=4");
  });

  /**
   * The bug this helper exists for. The old heuristic asked whether the page
   * came back full, and a last page that happens to be full is indistinguishable
   * from a page with more behind it — so <link rel="next"> named a page the
   * route itself answers with a 404.
   */
  it("advertises no next page when the total is an exact multiple of the limit", () => {
    expect(
      paginationUrls({ ...base, page: 1, total: 25 }).nextPageUrl,
    ).toBeUndefined();
    expect(
      paginationUrls({ ...base, page: 4, total: 100 }).nextPageUrl,
    ).toBeUndefined();
  });

  it("advertises a next page while rows remain", () => {
    expect(paginationUrls({ ...base, page: 1, total: 26 }).nextPageUrl).toBe(
      "https://example.com/games?page=2",
    );
  });

  it("advertises no next page when nothing matched", () => {
    const { canonicalUrl, prevPageUrl, nextPageUrl } = paginationUrls({
      ...base,
      page: 1,
      total: 0,
    });

    expect(canonicalUrl).toBe("https://example.com/games");
    expect(prevPageUrl).toBeUndefined();
    expect(nextPageUrl).toBeUndefined();
  });

  // The homepage's base URL carries the trailing slash, so the query composes
  // onto it as "/?page=2" rather than "//?page=2".
  it("composes onto a base URL that ends in a slash", () => {
    expect(
      paginationUrls({
        baseUrl: "https://example.com/",
        limit: 25,
        page: 1,
        total: 60,
      }).nextPageUrl,
    ).toBe("https://example.com/?page=2");
  });
});

/**
 * Page 2 of every listing on the site used to be served under exactly the
 * title and meta description of page 1, and routes/sitemap.ts submits all of
 * those addresses — so the sitemap advertised several hundred URLs a crawler
 * could not tell apart by their titles.
 */
describe("paginatedTitle", () => {
  it("leaves page 1 alone", () => {
    expect(paginatedTitle("Classic MS-DOS Action Games | OldSchoolGames", 1))
      .toBe("Classic MS-DOS Action Games | OldSchoolGames");
  });

  // The number goes before the brand, so the sentence still ends where a
  // reader expects it to.
  it("numbers the page in front of the brand", () => {
    expect(paginatedTitle("Classic MS-DOS Action Games | OldSchoolGames", 2))
      .toBe("Classic MS-DOS Action Games \u2013 Page 2 | OldSchoolGames");
  });

  it.each([
    ["Games from 1993 - OldSchoolGames", "Games from 1993 \u2013 Page 3 - OldSchoolGames"],
    ["About - OldSchoolGames.eu", "About \u2013 Page 3 - OldSchoolGames.eu"],
  ])("handles the other brand spellings: %s", (input, expected) => {
    expect(paginatedTitle(input, 3)).toBe(expected);
  });

  // The site-wide default opens with the brand rather than closing with it, so
  // there is nothing to insert in front of — it takes the marker on the end.
  it("falls back to appending when the title does not end in the brand", () => {
    expect(
      paginatedTitle("OldSchoolGames - Play classic MS-DOS Games Online", 2),
    ).toBe("OldSchoolGames - Play classic MS-DOS Games Online \u2013 Page 2");
  });

  // The brand has to be at the end to be the brand. A title merely mentioning
  // it takes the appending fallback, not an insertion after the mention.
  it("does not mistake a brand mention mid-title for the suffix", () => {
    expect(paginatedTitle("OldSchoolGames turns five | Retro News", 2)).toBe(
      "OldSchoolGames turns five | Retro News \u2013 Page 2",
    );
  });

  /**
   * The marker is nine characters, so a title written to sit just inside the
   * limit on page 1 was over it on page 2 — which is what the genre listings
   * did: 59 characters on the first page and 68 on the second.
   */
  it("cuts the lead to make room for the marker", () => {
    const title = "MS-DOS Simulation Games \u2013 Play Free Online | OldSchoolGames";
    const result = paginatedTitle(title, 2);

    expect(result.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(result).toContain("\u2013 Page 2");
    expect(result.endsWith("| OldSchoolGames")).toBe(true);
  });

  it("stays within TITLE_MAX at every page number and length", () => {
    for (const page of [2, 9, 10, 99, 100, 10000]) {
      for (const length of [10, 40, 59, 60, 120]) {
        const title = `${"n".repeat(length)} | OldSchoolGames`;

        expect(paginatedTitle(title, page).length).toBeLessThanOrEqual(
          TITLE_MAX,
        );
      }
    }
  });
});

describe("paginatedDescription", () => {
  it("leaves a page 1 description that already fits alone", () => {
    expect(paginatedDescription("Browse the catalogue.", 1)).toBe(
      "Browse the catalogue.",
    );
  });

  /**
   * Page 1 used to be returned untouched whatever its length, and this is the
   * only limit the routes that compose a description from a template ever
   * passed through — so the genre pages shipped 175 characters, the letter
   * pages up to 213, and their *second* pages were the ones correctly cut.
   */
  it("cuts an over-long page 1 description to the limit", () => {
    const long = "word ".repeat(80).trim();

    expect(long.length).toBeGreaterThan(META_DESCRIPTION_MAX);
    expect(paginatedDescription(long, 1).length).toBeLessThanOrEqual(
      META_DESCRIPTION_MAX + 1,
    );
  });

  it("leads with the page number", () => {
    expect(paginatedDescription("Browse the catalogue.", 4)).toBe(
      "Page 4: Browse the catalogue.",
    );
  });

  /**
   * The marker leads rather than trails precisely so that this cut cannot take
   * it off again: several of the descriptions it is handed already sit at the
   * limit.
   */
  it("keeps the marker when the result has to be cut", () => {
    const long = "word ".repeat(80).trim();
    const result = paginatedDescription(long, 2);

    expect(result.startsWith("Page 2: ")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(160);
  });
});

/**
 * There were three copies of `Math.max(1, Math.ceil(total / limit))` — in
 * paginationUrls, in News.findAll and in the comments overview — which is
 * exactly the shape a fix reaches one of and leaves the other two behind.
 */
describe("totalPages", () => {
  it("counts the pages a listing runs to", () => {
    expect(totalPages(100, 25)).toBe(4);
    expect(totalPages(101, 25)).toBe(5);
    expect(totalPages(1, 25)).toBe(1);
  });

  /**
   * At least one page even with nothing to show. Math.ceil(0 / 10) is 0, so
   * an empty /news rendered "page 1 of 0" and views/pagination.ejs had a
   * current page number above its own total to reason about.
   */
  it("reports one page for an empty listing", () => {
    expect(totalPages(0, 25)).toBe(1);
  });

  /**
   * Nothing passes a limit like this today. It is guarded so that a caller
   * which computes one cannot turn a bad page size into Infinity, a negative
   * count, or a pagination widget offering an unbounded number of pages.
   */
  it("treats a limit of zero or less as one", () => {
    expect(totalPages(10, 0)).toBe(10);
    expect(totalPages(10, -5)).toBe(10);
    expect(Number.isFinite(totalPages(10, 0))).toBe(true);
  });
});
