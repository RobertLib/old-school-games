import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import sitemapRouter, { clearSitemapCache } from "../../routes/sitemap.ts";
import Game from "../../models/game.ts";

vi.mock("../../models/game", () => ({
  default: {
    findForSitemap: vi.fn(),
    count: vi.fn(),
    getGenres: vi.fn(),
    getDevelopers: vi.fn(),
    getPublishers: vi.fn(),
    getYears: vi.fn(),
    getSitemapCounts: vi.fn(),
  },
}));

/**
 * The letter pages the sitemap lists, which are the pages of the A–Z browse
 * and nothing else.
 *
 * The loop used to walk the twenty-six letters alone. The digits' page —
 * "/letter/0-9", every game whose slug begins with a digit — is a page too,
 * and it has to be listed when it holds something and left out when it does
 * not, exactly as a letter is. Game.getSitemapCounts once produced keys for
 * pages no route answered ("letter:1", "letter:ü"); they cannot reach a URL
 * here now whatever the counts say, because the loop names the buckets from
 * utils/letter-buckets.ts rather than whatever keys arrive.
 *
 * Kept apart from tests/routes/sitemap.test.ts so the letter loop's own cases
 * sit together; the setup is the same shape.
 */

const app = express();
app.use("/", sitemapRouter);
app.use((req, res) => res.status(404).send("not found"));

const server = app.listen(0);

afterAll(() => {
  server.close();
});

function counts(entries: [string, number][]) {
  return { counts: new Map(entries), lastmods: new Map<string, string>() };
}

describe("the sitemap's letter pages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearSitemapCache();

    vi.mocked(Game.count).mockResolvedValue(3);
    vi.mocked(Game.findForSitemap).mockResolvedValue([]);
    vi.mocked(Game.getGenres).mockResolvedValue(["ACTION"]);
    vi.mocked(Game.getDevelopers).mockResolvedValue([]);
    vi.mocked(Game.getPublishers).mockResolvedValue([]);
    vi.mocked(Game.getYears).mockResolvedValue([]);
  });

  it("lists the digits' page when a slug begins with a digit", async () => {
    vi.mocked(Game.getSitemapCounts).mockResolvedValue(
      counts([
        ["letter:0-9", 2],
        ["letter:d", 1],
      ]),
    );

    const { text } = await request(server).get("/sitemap-1.xml");

    expect(text).toContain("<loc>https://oldschoolgames.eu/letter/0-9</loc>");
    expect(text).toContain("<loc>https://oldschoolgames.eu/letter/d</loc>");
  });

  it("lists its later pages like any letter's", async () => {
    vi.mocked(Game.getSitemapCounts).mockResolvedValue(
      counts([["letter:0-9", 60]]),
    );

    const { text } = await request(server).get("/sitemap-1.xml");

    expect(text).toContain(
      "<loc>https://oldschoolgames.eu/letter/0-9?page=2</loc>",
    );
    expect(text).toContain(
      "<loc>https://oldschoolgames.eu/letter/0-9?page=3</loc>",
    );
    expect(text).not.toContain("/letter/0-9?page=4");
  });

  it("leaves the digits' page out when no slug begins with one", async () => {
    vi.mocked(Game.getSitemapCounts).mockResolvedValue(
      counts([["letter:d", 1]]),
    );

    const { text } = await request(server).get("/sitemap-1.xml");

    expect(text).not.toContain("/letter/0-9");
  });

  // Keys for pages that do not exist are not URLs, whatever produced them.
  it("names no page that is not a bucket", async () => {
    vi.mocked(Game.getSitemapCounts).mockResolvedValue(
      counts([
        ["letter:1", 4],
        ["letter:ü", 2],
        ['letter:"', 1],
      ]),
    );

    const { text } = await request(server).get("/sitemap-1.xml");

    expect(text).not.toContain("/letter/");
  });
});
