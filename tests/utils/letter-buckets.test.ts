import { describe, expect, it } from "vitest";
import {
  DIGIT_BUCKET,
  LETTER_BUCKETS,
  isLetterBucket,
  letterBucketHeading,
  letterBucketInSentence,
  letterBucketLabel,
} from "../../utils/letter-buckets.ts";
import { slugify } from "../../utils/slug.ts";

/**
 * The bucket a slug falls into, the way the SQL in models/game.ts decides it:
 * a leading digit is the digits' page, anything else is its own first
 * character. Written out here rather than exported, because nothing but this
 * test needs to work it out in JavaScript.
 */
function bucketOf(slug: string): string {
  return /^[0-9]/.test(slug) ? DIGIT_BUCKET : slug.charAt(0);
}

describe("LETTER_BUCKETS", () => {
  it("is the twenty-six letters and one page for the digits", () => {
    expect(LETTER_BUCKETS).toHaveLength(27);
    expect(new Set(LETTER_BUCKETS).size).toBe(27);
    expect(LETTER_BUCKETS).toContain("0-9");
    expect(LETTER_BUCKETS.filter((bucket) => /^[a-z]$/.test(bucket))).toHaveLength(
      26,
    );
  });

  // Where titles beginning with a digit sort in any listing ordered by title.
  it("puts the digits first", () => {
    expect(LETTER_BUCKETS[0]).toBe(DIGIT_BUCKET);
    expect(LETTER_BUCKETS.slice(1).join("")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  /**
   * The point of bucketing by slug: slugify() has already reduced every title
   * to [a-z0-9-], so there is no title left over that no page lists. By title,
   * "1942", "688 Attack Sub" and "Über Racer" were on no letter page at all.
   */
  it.each([
    ["1942", "0-9"],
    ["688 Attack Sub", "0-9"],
    ["3-D Tic-Tac-Toe", "0-9"],
    ["Über Racer", "u"],
    ['"Nam" 1965', "n"],
    ["Ørcs of Øresund", "o"],
    ["Élite Plus", "e"],
    ["...And Justice for All", "a"],
    ["doom", "d"],
  ])("files %j under %s", (title, bucket) => {
    const slug = slugify(title);

    expect(bucketOf(slug)).toBe(bucket);
    expect(isLetterBucket(bucketOf(slug))).toBe(true);
  });

  // A title with nothing ASCII in it at all slugifies to nothing, and the
  // models give it the fallback base "game" — so it is on G, where its
  // address says it is.
  it("files a title slugify cannot spell under its fallback slug", () => {
    expect(slugify("東方")).toBe("");
    expect(bucketOf("game")).toBe("g");
  });
});

describe("isLetterBucket", () => {
  it.each(["a", "q", "z", "0-9"])("accepts the address %j", (value) => {
    expect(isLetterBucket(value)).toBe(true);
  });

  // Other spellings of an address are routes/home.ts's to redirect, and the
  // rest are not addresses at all.
  it.each(["A", "7", "0", "09", "0–9", "ab", "", "ü", "-", "%"])(
    "refuses %j",
    (value) => {
      expect(isLetterBucket(value)).toBe(false);
    },
  );
});

describe("what a bucket is called", () => {
  it("labels the filter's buttons", () => {
    expect(letterBucketLabel("a")).toBe("A");
    expect(letterBucketLabel("A")).toBe("A");
    expect(letterBucketLabel("0-9")).toBe("0–9");
  });

  it("finishes a heading", () => {
    expect(letterBucketHeading("d")).toBe("'D'");
    expect(letterBucketHeading("0-9")).toBe("a Number");
  });

  it("finishes a sentence", () => {
    expect(letterBucketInSentence("d")).toBe("'D'");
    expect(letterBucketInSentence("0-9")).toBe("a number");
  });
});
