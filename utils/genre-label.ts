/**
 * How a genre is written wherever a person reads it — a <title>, an H1, a
 * breadcrumb, a sidebar link — as opposed to how it is stored (the upper-case
 * enum) or addressed (its lower case, see the genre route in routes/home.ts).
 *
 * Every one of those used to be built the same way, first letter up and the
 * rest down, in a dozen places across the routes and the views. That is right
 * for every genre in the enum but one: "RPG" is an initialism, and it came out
 * as "Rpg" — "MS-DOS Rpg Games" in the title Google shows, "Classic MS-DOS Rpg
 * Games" in the H1, "Rpg Games" in the BreadcrumbList of every RPG page and
 * "Rpg" in the sidebar on every page of the site. One function now, so the
 * next initialism is one entry below rather than another dozen edits.
 *
 * Pure, and reachable from the unit project: utils/breadcrumbs.ts uses it, and
 * app.ts hands both functions to every view through app.locals.
 */

/** Genres written in capitals wherever they appear. */
const INITIALISMS = new Set(["RPG"]);

/** The genre as a heading writes it: "Action", "RPG". */
export function genreLabel(genre: string): string {
  const upper = genre.toUpperCase();

  if (INITIALISMS.has(upper)) return upper;

  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

/**
 * The genre in the middle of a sentence: "classic action games", "classic RPG
 * games". Lower case, the way English writes a common noun — except for an
 * initialism, which stays in capitals wherever it sits.
 */
export function genreInSentence(genre: string): string {
  const upper = genre.toUpperCase();

  return INITIALISMS.has(upper) ? upper : upper.toLowerCase();
}
