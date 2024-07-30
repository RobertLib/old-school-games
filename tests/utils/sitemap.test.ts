import { describe, expect, it } from "vitest";
import {
  buildSitemapChunks,
  MAX_SITEMAP_BYTES,
} from "../../utils/sitemap.ts";

const SITE_URL = "https://oldschoolgames.eu";

describe("sitemap XML chunks", () => {
  it("keeps every URL when the URL-count limit splits the catalogue", () => {
    const chunks = buildSitemapChunks(
      [{ url: "/first" }, { url: "/second" }, { url: "/third" }],
      SITE_URL,
      { maxUrls: 2 },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.toString()).toContain(`${SITE_URL}/first`);
    expect(chunks[0]!.toString()).toContain(`${SITE_URL}/second`);
    expect(chunks[1]!.toString()).toContain(`${SITE_URL}/third`);
  });

  it("measures escaped UTF-8 bytes, including the wrapper and separator", () => {
    const entries = [
      { url: "/ž&\"<>", lastmod: "2026-10-07" },
      { url: "/日本語" },
    ];
    const together = buildSitemapChunks(entries, SITE_URL)[0]!;
    const maxBytes = together.length;

    // Exact fits are allowed; one byte less has to split. Measuring source
    // characters, or forgetting the closing tag or newline, misses this edge.
    expect(buildSitemapChunks(entries, SITE_URL, { maxBytes })).toEqual([
      together,
    ]);
    const split = buildSitemapChunks(entries, SITE_URL, {
      maxBytes: maxBytes - 1,
    });
    expect(split).toHaveLength(2);
    expect(split.every((chunk) => chunk.length < maxBytes)).toBe(true);
    expect(split[0]!.toString()).toContain("/ž&amp;&quot;&lt;&gt;");
    expect(split[0]!.toString()).toContain("<lastmod>2026-10-07</lastmod>");
    expect(split[1]!.toString()).toContain("/日本語");
  });

  it("counts the image namespace when an image follows a plain entry", () => {
    const entries = [
      { url: "/plain" },
      { url: "/illustrated", images: ["https://media.example/á?a=1&b=2"] },
    ];
    const together = buildSitemapChunks(entries, SITE_URL)[0]!;
    const maxBytes = together.length - 1;
    const chunks = buildSitemapChunks(entries, SITE_URL, { maxBytes });

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= maxBytes)).toBe(true);
    expect(chunks[0]!.toString()).not.toContain("xmlns:image");
    expect(chunks[1]!.toString()).toContain("xmlns:image");
    expect(chunks[1]!.toString()).toContain("á?a=1&amp;b=2");
  });

  it("enforces the real 52,428,800-byte limit before 25,000 URLs", () => {
    // Repeated references keep the input small, while the emitted metadata
    // is actually over 50 MiB. This guards the production default itself,
    // separately from the small-budget boundary fixtures above.
    const image = "https://media.example/" + "a".repeat(1024 * 1024);
    const chunks = buildSitemapChunks(
      [
        { url: "/first", images: Array<string>(30).fill(image) },
        { url: "/second", images: Array<string>(30).fill(image) },
      ],
      SITE_URL,
    );

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= MAX_SITEMAP_BYTES)).toBe(true);
    expect(chunks[0]!.includes(Buffer.from(`${SITE_URL}/first`))).toBe(true);
    expect(chunks[1]!.includes(Buffer.from(`${SITE_URL}/second`))).toBe(true);
    expect(chunks[0]!.includes(Buffer.from("<image:image>"))).toBe(true);
    expect(chunks[1]!.includes(Buffer.from("<image:image>"))).toBe(true);
  });

  it("keeps an oversized entry's URL and lastmod with images that still fit", () => {
    const smallImage = "https://media.example/small.png";
    const entry = { url: "/oversized", lastmod: "2026-10-07" };
    const maxBytes = buildSitemapChunks(
      [{ ...entry, images: [smallImage] }],
      SITE_URL,
    )[0]!.length;
    const chunks = buildSitemapChunks(
      [
        {
          ...entry,
          images: [
            "https://media.example/" + "a".repeat(maxBytes),
            smallImage,
            smallImage,
          ],
        },
        { url: "/after" },
      ],
      SITE_URL,
      { maxBytes },
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.length).toBe(maxBytes);
    expect(chunks[0]!.toString()).toContain(`${SITE_URL}/oversized`);
    expect(chunks[0]!.toString()).toContain("<lastmod>2026-10-07</lastmod>");
    expect(chunks[0]!.toString()).toContain(smallImage);
    expect([...chunks[0]!.toString().matchAll(/<image:image>/g)]).toHaveLength(1);
    expect(chunks[1]!.toString()).toContain(`${SITE_URL}/after`);
  });

  it("budgets images after XML escaping rather than fitting their raw values", () => {
    const entry = { url: "/escaped-image" };
    const reference = buildSitemapChunks(
      [{ ...entry, images: ["https://media.example/" + "a".repeat(20)] }],
      SITE_URL,
    )[0]!;
    const chunks = buildSitemapChunks(
      [{ ...entry, images: ["https://media.example/" + "&".repeat(20)] }],
      SITE_URL,
      { maxBytes: reference.length },
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.length).toBeLessThan(reference.length);
    expect(chunks[0]!.toString()).toContain(`${SITE_URL}/escaped-image`);
    expect(chunks[0]!.toString()).not.toContain("xmlns:image");
    expect(chunks[0]!.toString()).not.toContain("<image:image>");
  });

  it("produces a valid empty document instead of an index with no chunk", () => {
    const chunks = buildSitemapChunks([], SITE_URL);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.toString()).toContain('<urlset xmlns="');
    expect(chunks[0]!.toString()).toMatch(/\n<\/urlset>$/);
    expect(chunks[0]!.toString()).not.toContain("<url>");
  });

  it("refuses an impossible core URL instead of dropping or truncating it", () => {
    expect(() =>
      buildSitemapChunks([{ url: "/" + "a".repeat(1000) }], SITE_URL, {
        maxBytes: 300,
      }),
    ).toThrow("A sitemap URL exceeds the chunk byte limit");
  });
});
