import { describe, expect, it } from "vitest";
import {
  breadcrumbLdJson,
  buildBreadcrumbs,
  type Breadcrumb,
} from "../../utils/breadcrumbs.ts";
import { SITE_URL } from "../../utils/site.ts";

/** The trail as "Name -> /path" pairs, which is what the assertions read. */
function trail(crumbs: Breadcrumb[]): string[] {
  return crumbs.map((crumb) => `${crumb.name} -> ${crumb.path ?? "(current)"}`);
}

describe("buildBreadcrumbs", () => {
  it("gives a page with no path a trail of Home alone", () => {
    expect(trail(buildBreadcrumbs({}))).toEqual(["Home -> (current)"]);
  });

  it("titles a genre however the address spelled it", () => {
    // /action, /Action and /ACTION all answer 200, so all three arrive here.
    for (const genre of ["action", "Action", "ACTION"]) {
      expect(trail(buildBreadcrumbs({ genre }))).toEqual([
        `Home -> /`,
        "Action Games -> (current)",
      ]);
    }
  });

  it("reads the genre off the game on a detail page", () => {
    // The detail route passes no `genre` local — the genre is on the game, and
    // it is the stored enum, so upper case.
    expect(
      trail(buildBreadcrumbs({ game: { title: "Doom", genre: "ACTION" } })),
    ).toEqual([
      "Home -> /",
      "Action Games -> /action",
      "Doom -> (current)",
    ]);
  });

  it("leaves the genre step out for a game filed under none", () => {
    expect(trail(buildBreadcrumbs({ game: { title: "Doom" } }))).toEqual([
      "Home -> /",
      "Doom -> (current)",
    ]);
  });

  it("puts the hub page above a developer and a publisher", () => {
    expect(trail(buildBreadcrumbs({ developer: "id Software" }))).toEqual([
      "Home -> /",
      "Developers -> /developers",
      "id Software -> (current)",
    ]);

    expect(trail(buildBreadcrumbs({ publisher: "Apogee" }))).toEqual([
      "Home -> /",
      "Publishers -> /publishers",
      "Apogee -> (current)",
    ]);
  });

  it("shows a studio name with a slash in it as stored", () => {
    // The name is the current page, so it is not linked and the escaped
    // address built for it never reaches the markup — but a name carrying a
    // slash must not be mangled on the way to being displayed either.
    expect(trail(buildBreadcrumbs({ developer: "Lucasfilm Games / LEC" }))).toEqual([
      "Home -> /",
      "Developers -> /developers",
      "Lucasfilm Games / LEC -> (current)",
    ]);
  });

  it("accepts the year as the number the route renders", () => {
    expect(trail(buildBreadcrumbs({ year: 1993 }))).toEqual([
      "Home -> /",
      "Years -> /years",
      "1993 -> (current)",
    ]);
  });

  it("upper-cases the letter and lower-cases its address", () => {
    expect(trail(buildBreadcrumbs({ letter: "d" }))).toEqual([
      "Home -> /",
      "Games starting with 'D' -> (current)",
    ]);
  });

  it("names News above an article", () => {
    expect(
      trail(buildBreadcrumbs({ newsItem: { title: "New games added" } })),
    ).toEqual([
      "Home -> /",
      "News -> /news",
      "New games added -> (current)",
    ]);
  });

  it("never links the last step, whichever branch produced it", () => {
    for (const locals of [
      { genre: "action" },
      { letter: "d" },
      { year: 1993 },
      { developer: "id Software" },
      { publisher: "Apogee" },
      { game: { title: "Doom", genre: "ACTION" } },
      { newsItem: { title: "New games added" } },
    ]) {
      const crumbs = buildBreadcrumbs(locals);

      expect(crumbs[crumbs.length - 1]!.path).toBeUndefined();
      // And every step before it is a link.
      for (const crumb of crumbs.slice(0, -1)) {
        expect(crumb.path).toBeTruthy();
      }
    }
  });

  it("ignores locals that are present but empty", () => {
    expect(
      trail(buildBreadcrumbs({ genre: "", developer: "", newsItem: {} })),
    ).toEqual(["Home -> (current)"]);
  });
});

describe("breadcrumbLdJson", () => {
  it("emits nothing for a trail of Home alone", () => {
    expect(breadcrumbLdJson(buildBreadcrumbs({}))).toBeNull();
  });

  it("numbers the steps from one and absolutises their addresses", () => {
    const ldJson = breadcrumbLdJson(
      buildBreadcrumbs({ game: { title: "Doom", genre: "ACTION" } }),
    );

    expect(ldJson).toEqual({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        {
          "@type": "ListItem",
          position: 1,
          name: "Home",
          item: `${SITE_URL}/`,
        },
        {
          "@type": "ListItem",
          position: 2,
          name: "Action Games",
          item: `${SITE_URL}/action`,
        },
        { "@type": "ListItem", position: 3, name: "Doom" },
      ],
    });
  });

  it("says the same thing the visible trail does", () => {
    // The one property this file exists to hold: the schema and the markup are
    // built from one array, so a name cannot appear in one and not the other.
    const crumbs = buildBreadcrumbs({ year: 1993 });
    const ldJson = breadcrumbLdJson(crumbs) as {
      itemListElement: { name: string }[];
    };

    expect(ldJson.itemListElement.map((item) => item.name)).toEqual(
      crumbs.map((crumb) => crumb.name),
    );
  });
});
