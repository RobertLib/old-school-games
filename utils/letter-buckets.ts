/**
 * The A–Z browse: which page of it a game is listed on, and what each page is
 * called.
 *
 * The letter pages used to be keyed on the first character of a game's
 * *title*, and only the twenty-six Latin letters had an address. So "1942" and
 * "688 Attack Sub" were on no letter page at all, and neither was "Über
 * Racer": its title starts with "Ü", which is none of the twenty-six.
 * Game.getSitemapCounts grouped on that same first character anyway and so
 * counted keys — "letter:1", "letter:ü" — that no route served, and
 * "/letter/1" was a 404.
 *
 * A game is filed under the first character of its *slug* now. slugify() in
 * utils/slug.ts has already folded the title onto [a-z0-9-] — "Über Racer" is
 * "uber-racer", '"Nam" 1965' is "nam-1965" — so every game lands in exactly one
 * of twenty-seven buckets: a letter, or the digits, which share one page
 * because a page per digit would be ten thin pages where one does. The bucket
 * is also the first character of the address the reader sees for the game, so
 * the page it is listed on agrees with the URL it is listed under.
 *
 * Two consequences, accepted rather than special-cased: a slug written before
 * slugify() folded diacritics (the SQL backfills in 0019 and 0035 — see
 * resolveSlugForUpdate) files its game under whatever the address starts with,
 * so a "ber-racer" is on B; and a title with nothing ASCII in it at all has the
 * fallback slug "game" and is on G. Both are where the game's own address says
 * they are, which is the one thing a reader can check.
 *
 * Pure, and reachable from the unit project: models/game.ts builds the filter
 * from DIGIT_BUCKET, routes/home.ts validates the address against the list,
 * routes/sitemap.ts and middlewares/sidebar-data.ts walk it, and
 * utils/breadcrumbs.ts names the pages with the functions below.
 */

/**
 * The one bucket that is not a letter: every slug that begins with a digit.
 * Also its address — "/letter/0-9" — which is why it is plain ASCII.
 */
export const DIGIT_BUCKET = "0-9";

/**
 * Every bucket, in the order the alphabet filter shows them.
 *
 * The digits first, because that is where titles beginning with one sort in
 * every listing ordered by title, and where an index that opens with "0–9" or
 * "#" has put them for as long as there have been indexes.
 */
export const LETTER_BUCKETS: readonly string[] = [
  DIGIT_BUCKET,
  ..."abcdefghijklmnopqrstuvwxyz",
];

const BUCKETS: ReadonlySet<string> = new Set(LETTER_BUCKETS);

/**
 * Whether `value` is a bucket's address exactly as the site writes it: a
 * lower-case letter, or "0-9". "/letter/A" and "/letter/7" are not addresses
 * but other spellings of one — routes/home.ts redirects them.
 */
export function isLetterBucket(value: string): boolean {
  return BUCKETS.has(value);
}

/** The bucket as the alphabet filter labels it: "A", or "0–9". */
export function letterBucketLabel(bucket: string): string {
  const key = bucket.toLowerCase();

  return key === DIGIT_BUCKET ? "0–9" : key.toUpperCase();
}

/**
 * How a heading finishes "Games Starting with …": "'A'", or "a Number".
 *
 * Not "'0–9'": quoted like a letter it reads as a range of characters rather
 * than as the titles it stands for, and nobody says a game "starts with
 * zero-to-nine".
 */
export function letterBucketHeading(bucket: string): string {
  const key = bucket.toLowerCase();

  return key === DIGIT_BUCKET ? "a Number" : `'${key.toUpperCase()}'`;
}

/** The same in the middle of a sentence: "'A'", or "a number". */
export function letterBucketInSentence(bucket: string): string {
  const key = bucket.toLowerCase();

  return key === DIGIT_BUCKET ? "a number" : `'${key.toUpperCase()}'`;
}
