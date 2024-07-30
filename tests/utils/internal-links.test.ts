import { describe, it, expect } from "vitest";
import {
  generateContextualLinks,
  generateRelatedGameLinks,
  generatePopularLinks,
} from "../../utils/internal-links.ts";

describe("internal-links utils", () => {
  describe("generateContextualLinks", () => {
    it("always includes base navigation links", () => {
      const links = generateContextualLinks({});
      const urls = links.map((l) => l.url);
      expect(urls).toContain("/");
      expect(urls).toContain("/developers");
      expect(urls).toContain("/publishers");
      expect(urls).toContain("/years");
    });

    it("includes genre link when genre is provided", () => {
      const links = generateContextualLinks({ genre: "ACTION" });
      const genreLink = links.find((l) => l.url === "/action");
      expect(genreLink).toBeDefined();
      expect(genreLink!.text).toBe("ACTION Games");
    });

    it("lowercases the genre in the URL", () => {
      const links = generateContextualLinks({ genre: "STRATEGY" });
      const genreLink = links.find((l) => l.url === "/strategy");
      expect(genreLink).toBeDefined();
    });

    it("includes developer link when developer is provided", () => {
      const links = generateContextualLinks({ developer: "id Software" });
      const devLink = links.find((l) => l.text === "Games by id Software");
      expect(devLink).toBeDefined();
      expect(devLink!.url).toBe(
        `/developer/${encodeURIComponent("id Software")}`,
      );
    });

    it("includes publisher link when publisher differs from developer", () => {
      const links = generateContextualLinks({
        developer: "Dev Co",
        publisher: "Pub Co",
      });
      const pubLink = links.find((l) => l.text.includes("Pub Co"));
      expect(pubLink).toBeDefined();
    });

    it("does NOT include publisher link when publisher equals developer", () => {
      const links = generateContextualLinks({
        developer: "Same Co",
        publisher: "Same Co",
      });
      const pubLink = links.find((l) => l.url.includes("/publisher/"));
      expect(pubLink).toBeUndefined();
    });

    it("does not include publisher link when only developer is provided", () => {
      const links = generateContextualLinks({ developer: "Solo Dev" });
      const pubLink = links.find((l) => l.url.includes("/publisher/"));
      expect(pubLink).toBeUndefined();
    });

    it("includes year, previous year and next year links when year is provided", () => {
      const links = generateContextualLinks({ year: 1995 });
      const urls = links.map((l) => l.url);
      expect(urls).toContain("/year/1995");
      expect(urls).toContain("/year/1994");
      expect(urls).toContain("/year/1996");
    });

    it("returns links sorted by priority descending", () => {
      const links = generateContextualLinks({
        genre: "RPG",
        year: 1990,
        developer: "Dev",
      });
      for (let i = 1; i < links.length; i++) {
        expect(links[i - 1].priority).toBeGreaterThanOrEqual(links[i].priority);
      }
    });

    it("returns sorted links for empty context", () => {
      const links = generateContextualLinks({});
      for (let i = 1; i < links.length; i++) {
        expect(links[i - 1].priority).toBeGreaterThanOrEqual(links[i].priority);
      }
    });

    it("returns all base links plus genre and year links", () => {
      const links = generateContextualLinks({ genre: "RPG", year: 1993 });
      const urls = links.map((l) => l.url);
      // 4 base + 1 genre + 3 year
      expect(urls.length).toBe(8);
    });
  });

  describe("generateRelatedGameLinks", () => {
    it("returns genre link when game has genre", () => {
      const links = generateRelatedGameLinks({ genre: "ACTION" });
      const link = links.find((l) => l.url === "/action");
      expect(link).toBeDefined();
      expect(link!.text).toBe("More action games");
    });

    it("lowercases genre in URL", () => {
      const links = generateRelatedGameLinks({ genre: "STRATEGY" });
      expect(links.find((l) => l.url === "/strategy")).toBeDefined();
    });

    it("returns developer link when game has developer", () => {
      const links = generateRelatedGameLinks({ developer: "Blizzard" });
      const link = links.find((l) =>
        l.url.includes(`/developer/${encodeURIComponent("Blizzard")}`),
      );
      expect(link).toBeDefined();
      expect(link!.text).toBe("More games by Blizzard");
    });

    it("returns publisher link when publisher differs from developer", () => {
      const links = generateRelatedGameLinks({
        developer: "Dev",
        publisher: "Pub",
      });
      const pubLink = links.find((l) => l.url.includes("/publisher/"));
      expect(pubLink).toBeDefined();
      expect(pubLink!.text).toBe("More games published by Pub");
    });

    it("does NOT return publisher link when same as developer", () => {
      const links = generateRelatedGameLinks({
        developer: "Same Co",
        publisher: "Same Co",
      });
      const pubLink = links.find((l) => l.url.includes("/publisher/"));
      expect(pubLink).toBeUndefined();
    });

    it("returns year link when game has release year", () => {
      const links = generateRelatedGameLinks({ release: 1993 });
      const yearLink = links.find((l) => l.url === "/year/1993");
      expect(yearLink).toBeDefined();
      expect(yearLink!.text).toBe("More games from 1993");
    });

    it("returns empty array for game with no relevant props", () => {
      const links = generateRelatedGameLinks({});
      expect(links).toEqual([]);
    });

    it("returns all applicable links for a fully-populated game", () => {
      const links = generateRelatedGameLinks({
        genre: "RPG",
        developer: "MicroProse",
        publisher: "EA",
        release: 1994,
      });
      // genre + developer + publisher + year
      expect(links.length).toBe(4);
    });

    it("encodes special characters in developer/publisher URLs", () => {
      const links = generateRelatedGameLinks({ developer: "Irrational Games" });
      const link = links.find((l) => l.url.includes("/developer/"));
      expect(link!.url).toBe(
        `/developer/${encodeURIComponent("Irrational Games")}`,
      );
    });
  });

  describe("generatePopularLinks", () => {
    it("returns a non-empty array", () => {
      const links = generatePopularLinks();
      expect(links.length).toBeGreaterThan(0);
    });

    it("includes Top Rated Games link", () => {
      const links = generatePopularLinks();
      const link = links.find((l) => l.text === "Top Rated Games");
      expect(link).toBeDefined();
      expect(link!.url).toBe("/?orderBy=rating&orderDir=DESC");
    });

    it("includes Recently Added link", () => {
      const links = generatePopularLinks();
      const link = links.find((l) => l.text === "Recently Added");
      expect(link).toBeDefined();
      expect(link!.url).toBe("/?orderBy=createdAt&orderDir=DESC");
    });

    it("includes genre-specific links", () => {
      const links = generatePopularLinks();
      const urls = links.map((l) => l.url);
      expect(urls).toContain("/adventure");
      expect(urls).toContain("/action");
      expect(urls).toContain("/strategy");
    });

    it("includes year-specific links", () => {
      const links = generatePopularLinks();
      const urls = links.map((l) => l.url);
      expect(urls).toContain("/year/1990");
      expect(urls).toContain("/year/1995");
    });

    it("returns stable results on repeated calls", () => {
      const first = generatePopularLinks();
      const second = generatePopularLinks();
      expect(first).toEqual(second);
    });
  });
});
