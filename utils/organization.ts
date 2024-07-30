import {
  SITE_LOGO,
  SITE_LOGO_SIZE,
  SITE_NAME,
  SITE_URL,
} from "./site.ts";

/**
 * The one address the site's publisher is known by.
 *
 * Every Organization node on the site carries it, which is what makes them
 * one entity rather than several. Three separate nodes used to describe this
 * organisation and only one of them had an `@id`:
 *
 *   - views/index.ejs, in the home page's @graph, with an @id, the name
 *     "OldSchoolGames.eu" and the 32x32 favicon as its logo;
 *   - views/about.ejs, with no @id, the same name, the same favicon, plus a
 *     founder and a contact point the home page never mentioned;
 *   - routes/news.ts, with no @id, the name "OldSchoolGames", and
 *     navbar.webp as its logo — twice over, as the article's author and again
 *     as its publisher.
 *
 * A node with no `@id` is a fresh entity every time it appears, so that was
 * three publishers for one site, under two names, with two logos between
 * them. The comment in views/index.ejs even recorded the intent to move this
 * to one place; the copy on /about was never taken back out.
 *
 * Nothing is lost in the merge: the founder and contact point from /about are
 * part of the one description now and so are stated on every page that names
 * the publisher, and the name is SITE_NAME with the other spelling kept as an
 * alternateName.
 */
export const ORGANIZATION_ID = `${SITE_URL}/#organization`;

/**
 * How to point at the organisation without describing it again.
 *
 * JSON-LD resolves a bare `@id` against the nodes on the page, so this is the
 * form to use for a second mention — an article's author beside its publisher,
 * say — where repeating the whole node would only invite the two copies to
 * drift apart.
 */
export const ORGANIZATION_REF = { "@id": ORGANIZATION_ID };

/**
 * The publisher of everything on the site, as schema.org Organization.
 *
 * A function rather than a frozen constant only so that each caller gets an
 * object of its own: these go into a JSON-LD graph that callers extend, and a
 * shared object would carry one page's additions onto the next.
 */
export function organizationNode(): Record<string, unknown> {
  return {
    "@type": "Organization",
    "@id": ORGANIZATION_ID,
    name: SITE_NAME,
    alternateName: "OldSchoolGames.eu",
    url: `${SITE_URL}/`,
    logo: {
      "@type": "ImageObject",
      url: SITE_LOGO,
      width: SITE_LOGO_SIZE,
      height: SITE_LOGO_SIZE,
    },
    description:
      "A hobby project dedicated to preserving and celebrating classic " +
      "MS-DOS games from the 80s and 90s.",
    founder: {
      "@type": "Person",
      name: "RobLib",
      url: "https://roblib.dev",
      sameAs: [
        "https://github.com/RobertLib",
        "https://twitter.com/RobertLibsansky",
      ],
    },
    contactPoint: {
      "@type": "ContactPoint",
      contactType: "Customer Support",
      email: "contact@oldschoolgames.eu",
    },
    sameAs: [
      "https://github.com/RobertLib",
      "https://twitter.com/RobertLibsansky",
    ],
  };
}
