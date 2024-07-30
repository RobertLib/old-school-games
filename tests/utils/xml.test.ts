import { describe, expect, it } from "vitest";
import { JSDOM } from "jsdom";
import { escapeXml, stripInvalidXmlChars } from "../../utils/xml";

/** Whether a document a feed or sitemap would send actually parses. */
function parses(xml: string): boolean {
  const { window } = new JSDOM("");
  const doc = new window.DOMParser().parseFromString(xml, "text/xml");

  return doc.querySelector("parsererror") === null;
}

describe("stripInvalidXmlChars", () => {
  it("drops the C0 control characters XML has no representation for", () => {
    const value = `a${String.fromCharCode(0)}b${String.fromCharCode(1)}c`;

    expect(stripInvalidXmlChars(value)).toBe("abc");
    expect(stripInvalidXmlChars("xyz")).toBe("xyz");
  });

  // These three are the C0 characters XML explicitly allows, and a
  // description written across several lines depends on them surviving.
  it("keeps tab, newline and carriage return", () => {
    expect(stripInvalidXmlChars("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("keeps ordinary text, accents and astral characters", () => {
    expect(stripInvalidXmlChars("Pokémon — 100% ✓")).toBe("Pokémon — 100% ✓");
    // A surrogate *pair* is one valid character and must not be touched.
    expect(stripInvalidXmlChars("\u{1F600}")).toBe("\u{1F600}");
  });

  it("drops a surrogate left without its pair", () => {
    expect(stripInvalidXmlChars("a\uD800b")).toBe("ab");
    expect(stripInvalidXmlChars("a\uDC00b")).toBe("ab");
    // The lead of a real pair, kept, followed by an orphan, dropped.
    expect(stripInvalidXmlChars(`\u{1F600}\uD800`)).toBe("\u{1F600}");
  });

  it("drops the permanently unassigned non-characters", () => {
    expect(stripInvalidXmlChars("a￾b￿c")).toBe("abc");
  });
});

describe("escapeXml", () => {
  it("escapes all five markup characters", () => {
    expect(escapeXml(`Sam & Max <"it's">`)).toBe(
      "Sam &amp; Max &lt;&quot;it&apos;s&quot;&gt;",
    );
  });

  // "&" first: escaping it afterwards would rewrite the ampersands the other
  // four replacements had just introduced.
  it("does not re-escape the ampersands it introduces", () => {
    expect(escapeXml("<")).toBe("&lt;");
    expect(escapeXml("&amp;")).toBe("&amp;amp;");
  });

  it("strips what XML cannot carry as well as escaping", () => {
    expect(escapeXml(`Doom${String.fromCharCode(1)} & Doom II`)).toBe(
      "Doom &amp; Doom II",
    );
  });
});

/**
 * The reason this module exists. A control character cannot be escaped into
 * legality — not even as "&#1;" — so a title carrying one used to make the
 * whole document unparseable, which costs every subscriber and crawler the
 * entire feed rather than the one item.
 */
describe("documents built from escaped values", () => {
  const wrap = (title: string) =>
    `<?xml version="1.0" encoding="UTF-8"?><rss><channel>` +
    `<item><title>${escapeXml(title)}</title></item>` +
    `</channel></rss>`;

  it("parses when a title holds a control character", () => {
    expect(parses(wrap(`Doom${String.fromCharCode(1)}Collection`))).toBe(true);
  });

  it("parses when a title holds markup and an ampersand", () => {
    expect(parses(wrap(`<script> & "Max"`))).toBe(true);
  });

  it("parses when a title holds a lone surrogate", () => {
    expect(parses(wrap("Doom\uD800"))).toBe(true);
  });

  // Guards the premise: without the stripping this suite would pass whatever
  // escapeXml did, because a bare escape leaves the byte in place.
  it("would not parse if the control character were merely escaped", () => {
    const escapedOnly = `<?xml version="1.0" encoding="UTF-8"?><rss><channel>` +
      `<item><title>Doom${String.fromCharCode(1)}</title></item>` +
      `</channel></rss>`;

    expect(parses(escapedOnly)).toBe(false);
  });
});
