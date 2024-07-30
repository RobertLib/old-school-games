import { escapeXml } from "./xml.ts";

/**
 * One URL in the document.
 *
 * There is no `changefreq` and no `priority` here any more, and every entry
 * below used to carry at least one of them.
 *
 * Neither was ever read by anything this site is submitted to. Google has said
 * plainly, and repeatedly, that it ignores both — priority because a value a
 * site assigns to its own pages carries no information (every site's pages are
 * important to that site), changefreq because the crawler can see how often a
 * page actually changes and does not need to be told. Bing has said the same
 * of priority. So this was several hundred URLs each shipping two elements
 * written for no reader.
 *
 * Worse than merely useless, they were wrong in a way that invited trouble:
 * "daily" sat on listings that change when a game is added, which is not
 * daily, and the priorities encoded a ranking — 1.0 for the home page, 0.6 for
 * a deep publisher page — that this site has no way to act on and no engine
 * asked for.
 *
 * `lastmod` is the one freshness signal that survives, because it is the one
 * that is checked: Google uses it while it is consistently accurate and learns
 * to ignore it when it is not, which is why the route's entry builder declines
 * to stamp a date on a page it cannot date honestly.
 */
export interface SitemapEntry {
  url: string;
  lastmod?: string;
  /** Absolute addresses of artwork on the page. */
  images?: string[];
}

// Both limits apply to the final, uncompressed XML, not to its source data.
// 25,000 leaves room below the protocol's 50,000-URL ceiling, but by itself
// did not bound a chunk: 25,000 games with eight ordinary screenshot URLs
// produced 57 MiB, above the protocol's 52,428,800-byte limit.
export const MAX_SITEMAP_BYTES = 52_428_800;
const MAX_URLS_PER_SITEMAP = 25_000;

const HEADER =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"';
const PLAIN_HEADER = Buffer.from(HEADER + ">\n");
/**
 * The Google image sitemap extension.
 *
 * Every game page carries a cover and a handful of screenshots, and none of
 * them were submitted anywhere — so the one part of this catalogue that is
 * pure visual content had no route into image search but an ordinary crawl.
 *
 * <image:loc> is the whole of it. The extension also defines caption, title,
 * geo_location and license, and Google dropped support for all four in 2022;
 * writing them now would add bytes to every URL in the file for nothing.
 *
 * Declared on the <urlset> only when a chunk actually carries an image. The
 * listing pages here have none, and a namespace declared and never used is
 * noise in a document that crawlers fetch whole.
 */
const IMAGE_HEADER = Buffer.from(
  HEADER +
    '\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n',
);
const FOOTER = Buffer.from("\n</urlset>");
const URL_END = Buffer.from("  </url>");
const SEPARATOR = Buffer.from("\n");
const IMAGE_START = "    <image:image>\n      <image:loc>";
const IMAGE_END = "</image:loc>\n    </image:image>\n";
const IMAGE_OVERHEAD = Buffer.byteLength(IMAGE_START + IMAGE_END);

/**
 * Serializes each entry once and packs chunks by both URL count and UTF-8
 * bytes, including escaping, separators and the optional image namespace.
 * Smaller budgets are useful for checking exact boundaries without building
 * a 50 MiB fixture for every case; production uses the protocol limit.
 */
export function buildSitemapChunks(
  entries: SitemapEntry[],
  siteUrl: string,
  {
    maxBytes = MAX_SITEMAP_BYTES,
    maxUrls = MAX_URLS_PER_SITEMAP,
  }: { maxBytes?: number; maxUrls?: number } = {},
): Buffer[] {
  if (
    !Number.isInteger(maxBytes) ||
    maxBytes < PLAIN_HEADER.length + FOOTER.length ||
    maxBytes > MAX_SITEMAP_BYTES ||
    !Number.isInteger(maxUrls) ||
    maxUrls < 1 ||
    maxUrls > 50_000
  ) {
    throw new RangeError("Invalid sitemap chunk limits");
  }

  const chunks: Buffer[] = [];
  let parts: Buffer[] = [];
  let count = 0;
  let contentBytes = 0;
  let usesImages = false;

  const flush = () => {
    const header = usesImages ? IMAGE_HEADER : PLAIN_HEADER;
    // Concatenated once per finished chunk. Rebuilding XML to measure every
    // candidate prefix would make a catalogue quadratic in time and memory.
    chunks.push(
      Buffer.concat(
        [header, ...parts, FOOTER],
        header.length + contentBytes + FOOTER.length,
      ),
    );
    parts = [];
    count = 0;
    contentBytes = 0;
    usesImages = false;
  };

  for (const entry of entries) {
    let core = `  <url>\n    <loc>${escapeXml(siteUrl + entry.url)}</loc>\n`;
    if (entry.lastmod) {
      core += `    <lastmod>${escapeXml(entry.lastmod)}</lastmod>\n`;
    }

    const coreBytes = Buffer.byteLength(core) + URL_END.length;
    if (PLAIN_HEADER.length + coreBytes + FOOTER.length > maxBytes) {
      // A normal catalogue slug cannot reach this. Refuse an impossible core
      // rather than silently omit its URL or truncate it to a different one.
      throw new RangeError("A sitemap URL exceeds the chunk byte limit");
    }

    const entryParts = [Buffer.from(core)];
    let entryBytes = coreBytes;
    let entryUsesImages = false;
    let imageBudget =
      maxBytes - IMAGE_HEADER.length - FOOTER.length - coreBytes;

    for (const image of entry.images ?? []) {
      const escaped = escapeXml(image);
      const bytes = IMAGE_OVERHEAD + Buffer.byteLength(escaped);

      // Images are optional metadata. An entry larger than a whole chunk
      // keeps its URL and lastmod, and only complete images that fit. Skip a
      // single oversized image before allocating its XML buffer, so it cannot
      // take the entire sitemap down or cost another huge copy in memory.
      if (bytes > imageBudget) continue;

      entryParts.push(Buffer.from(IMAGE_START + escaped + IMAGE_END));
      entryBytes += bytes;
      imageBudget -= bytes;
      entryUsesImages = true;
    }

    entryParts.push(URL_END);
    const nextHeader =
      usesImages || entryUsesImages ? IMAGE_HEADER : PLAIN_HEADER;
    const nextBytes =
      nextHeader.length +
      contentBytes +
      (count > 0 ? SEPARATOR.length : 0) +
      entryBytes +
      FOOTER.length;

    if (count > 0 && (count >= maxUrls || nextBytes > maxBytes)) flush();

    if (count > 0) {
      parts.push(SEPARATOR);
      contentBytes += SEPARATOR.length;
    }
    for (const part of entryParts) parts.push(part);
    contentBytes += entryBytes;
    count += 1;
    usesImages ||= entryUsesImages;
  }

  // Even an empty catalogue has one valid document for its index to name.
  if (count > 0 || chunks.length === 0) flush();

  return chunks;
}
