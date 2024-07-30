import { describe, expect, it } from "vitest";
import {
  TITLE_MAX,
  decodeEntities,
  escapeHtml,
  fitTitle,
  htmlToPlainText,
  truncateAtWord,
} from "../../utils/html-text";
// What the detail pages render stored HTML through, so a summary can be
// checked against the page it summarises. Pure like this module: a JSDOM
// window and DOMPurify, no pool — see its own test in the unit project.
import { sanitizeHtml } from "../../utils/sanitize-html";

describe("decodeEntities", () => {
  it("decodes the entities HTML serialisation produces", () => {
    expect(decodeEntities("Sam &amp; Max")).toBe("Sam & Max");
    expect(decodeEntities("5 &lt; 6 &gt; 4")).toBe("5 < 6 > 4");
    expect(decodeEntities("&quot;quoted&quot;")).toBe('"quoted"');
    expect(decodeEntities("it&apos;s")).toBe("it's");
  });

  it("decodes numeric references, decimal and hex", () => {
    expect(decodeEntities("it&#39;s")).toBe("it's");
    expect(decodeEntities("it&#x27;s")).toBe("it's");
    expect(decodeEntities("&#x1F600;")).toBe("\u{1F600}");
  });

  // "&amp;lt;" is an author who typed the text "&lt;", not a less-than sign.
  // Decoding in one pass is what keeps the two apart; rescanning the
  // replacement would collapse both to "<".
  it("does not decode the output of its own replacements", () => {
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
    expect(decodeEntities("&amp;amp;")).toBe("&amp;");
  });

  it("leaves entities it does not know exactly as written", () => {
    expect(decodeEntities("caf&eacute;")).toBe("caf&eacute;");
    expect(decodeEntities("a &notanentity b")).toBe("a &notanentity b");
  });

  // String.fromCodePoint throws on these, and a malformed description is not
  // worth a 500.
  it("leaves out-of-range and surrogate references alone", () => {
    expect(decodeEntities("&#1114112;")).toBe("&#1114112;");
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
  });
});

describe("htmlToPlainText", () => {
  it("strips tags and decodes what DOMPurify escaped", () => {
    // What Game.serialize stores for the description "Sam & Max <b>ride</b>".
    expect(htmlToPlainText("<p>Sam &amp; Max <b>ride</b></p>")).toBe(
      "Sam & Max ride",
    );
  });

  it("separates block tags with a space rather than running words together", () => {
    expect(htmlToPlainText("<p>one</p><p>two</p>")).toBe("one two");
  });

  it("closes the gap a stripped tag leaves before punctuation", () => {
    expect(htmlToPlainText("<p>Legendary <b>shooter</b>.</p>")).toBe(
      "Legendary shooter.",
    );
  });

  it("collapses the non-breaking spaces it decodes", () => {
    expect(htmlToPlainText("a&nbsp;&nbsp;b")).toBe("a b");
  });

  it("answers empty for nothing at all", () => {
    expect(htmlToPlainText(null)).toBe("");
    expect(htmlToPlainText(undefined)).toBe("");
    expect(htmlToPlainText("")).toBe("");
  });

  // Decoding first would turn this back into a tag and then strip the text
  // out of the middle of it.
  it("keeps text an author escaped as text", () => {
    expect(htmlToPlainText("<p>use &lt;script&gt; carefully</p>")).toBe(
      "use <script> carefully",
    );
  });

  /**
   * DOMPurify leaves a ">" inside an attribute value as it is, and a tag
   * pattern that stopped at the first ">" ended the tag inside the alt text —
   * so 'Quake">' leaked into every meta description, the JSON-LD and the feed.
   */
  it("reads a tag through the quoted values of its attributes", () => {
    expect(htmlToPlainText('<p><img alt="Doom > Quake"> Rip and tear.</p>')).toBe(
      "Rip and tear.",
    );
    expect(htmlToPlainText("<a title='a > b' href='/x'>link</a>")).toBe("link");
  });

  /**
   * The text inside a <script> or a <style> is code, not prose, and no reader
   * is ever shown it. Only the tags used to be stripped, so a row that had
   * bypassed the model's sanitiser — Game.findBySlug and News.findBySlug
   * sanitise on read because such rows exist — reached every listing card,
   * the news excerpts and both RSS feeds as "Hello alert(2) x body{}", while
   * its own page, sanitised, read "Hello x".
   */
  it("drops what is inside a script or a style rather than printing it", () => {
    expect(
      htmlToPlainText(
        "<p>Hello <script>alert(2)</script> x</p><style>body{}</style>",
      ),
    ).toBe("Hello x");
  });

  it.each([
    ["template", "<template><p>inert</p></template>shown"],
    ["iframe", "<iframe>fallback</iframe>shown"],
    ["title", "<title>a title</title>shown"],
    ["noembed", "<noembed>fallback</noembed>shown"],
    ["noframes", "<noframes>fallback</noframes>shown"],
    ["xmp", "<xmp>raw</xmp>shown"],
    ["svg", "<svg><text>drawn</text><style>x{}</style></svg>shown"],
    ["math", "<math><mi>x</mi></math>shown"],
    ["video", "<video>Your browser cannot play this</video>shown"],
    ["audio", "<audio>Your browser cannot play this</audio>shown"],
  ])("drops the content of <%s>, which the page does not show either", (_tag, html) => {
    expect(htmlToPlainText(html)).toBe("shown");
  });

  it("is not fooled by case, attributes or an end tag with junk in it", () => {
    expect(
      htmlToPlainText('<SCRIPT type="text/javascript">alert(1)</SCRIPT>after'),
    ).toBe("after");
    expect(htmlToPlainText("<script>alert(1)</script foo>after")).toBe("after");
    expect(htmlToPlainText("<style media='x > y'>a{}</style>after")).toBe(
      "after",
    );
  });

  // A browser reads an unclosed <script> to the end of the document, so the
  // rest of it is script too — not text that happens to follow a tag.
  it("drops an unclosed script to the end", () => {
    expect(htmlToPlainText("<p>before</p><script>alert(1)<p>after</p>")).toBe(
      "before",
    );
  });

  // An element whose name merely starts with one of these is an ordinary tag.
  it("leaves the text of a tag that only begins like one of them", () => {
    expect(htmlToPlainText("<scripts>kept</scripts> <titles>too</titles>")).toBe(
      "kept too",
    );
  });

  /**
   * One pass in document order, not one pattern after another. DOMPurify keeps
   * a "<" inside an attribute value as it is, so `title="<script>"` survives
   * sanitising — and a script pattern run before the tag pattern found that
   * "<script>" inside the quotes and ate every word after it, looking for an
   * end tag that is not there.
   */
  it("does not mistake a quoted attribute value for a script", () => {
    expect(htmlToPlainText('<a title="<script>">link</a> tail')).toBe(
      "link tail",
    );
  });

  // Markup inside a comment is not markup: the tag pattern used to end the
  // comment at the first ">", leaving "x -->" in the text. And a comment is
  // not a word boundary either — "a<!-- -->b" is drawn as "ab" — so it goes
  // without leaving the space a tag does.
  it("drops an HTML comment whole, markup inside it included", () => {
    expect(htmlToPlainText("<p>a<!-- <b>x</b> -->b</p>")).toBe("ab");
    expect(htmlToPlainText("<p>a<!-- never closed")).toBe("a");
    // The two spellings HTML closes a comment early on, and the one it
    // accepts despite the "!".
    expect(htmlToPlainText("<!-->shown")).toBe("shown");
    expect(htmlToPlainText("<!--->shown")).toBe("shown");
    expect(htmlToPlainText("a<!-- x --!>b")).toBe("ab");
  });

  /**
   * The property all of the above is for: a summary says what the page it
   * summarises says. The detail pages render stored HTML through
   * sanitizeHtml, so flattening the raw row and flattening what the reader is
   * actually shown must agree.
   */
  it.each([
    "<p>Hello <script>alert(2)</script> x</p><style>body{}</style>",
    "<p>Doom</p><template><p>inert</p></template><p>Quake</p>",
    '<p>Rip <SCRIPT src="x.js"></SCRIPT>and tear.</p>',
    "<p>one</p><iframe>fallback</iframe><p>two</p>",
    "<p>a<!-- <b>x</b> -->b</p>",
    "<svg><text>drawn</text></svg><p>shown</p>",
  ])("summarises %j as its sanitised page reads", (raw) => {
    expect(htmlToPlainText(raw)).toBe(htmlToPlainText(sanitizeHtml(raw)));
  });
});

describe("escapeHtml", () => {
  it("escapes the characters HTML reads as markup", () => {
    expect(escapeHtml(`Sam & Max <Hit the Road> "it's"`)).toBe(
      "Sam &amp; Max &lt;Hit the Road&gt; &quot;it&#39;s&quot;",
    );
  });

  // "&" first, or it would rewrite the ampersands the others had introduced.
  it("escapes an ampersand exactly once", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  // What the feeds rely on: text that was decoded out of stored HTML goes
  // back to reading exactly as it did.
  it("is undone by decodeEntities", () => {
    for (const text of ["Press <Enter>", "a & b", "<b>bold</b>", `"'`]) {
      expect(decodeEntities(escapeHtml(text))).toBe(text);
    }
  });
});

describe("truncateAtWord", () => {
  it("leaves text within the limit untouched, with no ellipsis", () => {
    expect(truncateAtWord("short", 20)).toBe("short");
    expect(truncateAtWord("exactly ten", 11)).toBe("exactly ten");
  });

  it("cuts on a word boundary and marks the cut", () => {
    expect(truncateAtWord("the quick brown fox", 12)).toBe("the quick…");
  });

  it("falls back to a hard cut when there is no boundary to use", () => {
    expect(truncateAtWord("aaaaaaaaaa", 4)).toBe("aaaa…");
  });
});

describe("fitTitle", () => {
  const RICH = " - Play Online - OldSchoolGames";
  const PLAIN = " - OldSchoolGames";

  it("keeps the richest suffix that still fits", () => {
    expect(fitTitle("Doom", [RICH, PLAIN])).toBe(
      "Doom - Play Online - OldSchoolGames",
    );
  });

  /**
   * The whole point of the ladder: a name too long for the decorated suffix
   * gives up the decoration, not its own characters. "Indiana Jones and the
   * Last Crusade" used to be cut to make room for " - Play Online".
   */
  it("drops decoration before it drops any of the name", () => {
    expect(
      fitTitle("Indiana Jones and the Last Crusade", [RICH, PLAIN]),
    ).toBe("Indiana Jones and the Last Crusade - OldSchoolGames");
  });

  it("cuts the name only when even the shortest suffix does not fit", () => {
    const result = fitTitle(
      "Leisure Suit Larry in the Land of the Lounge Lizards",
      [RICH, PLAIN],
    );

    expect(result.endsWith(PLAIN)).toBe(true);
    expect(result).toContain("\u2026");
  });

  // The suffix is never what gets cut — a title that loses its brand loses
  // the part that says whose result it is.
  it("always ends in a whole suffix", () => {
    for (const name of [
      "Doom",
      "Indiana Jones and the Last Crusade",
      "Leisure Suit Larry in the Land of the Lounge Lizards",
      "x".repeat(255),
    ]) {
      expect(fitTitle(name, [RICH, PLAIN]).endsWith("OldSchoolGames")).toBe(
        true,
      );
    }
  });

  /**
   * Including the ellipsis, which is why the cut asks truncateAtWord for one
   * character less than the budget: truncateAtWord returns up to maxLength + 1.
   */
  it("never returns more than TITLE_MAX characters", () => {
    for (let length = 1; length <= 120; length++) {
      expect(fitTitle("n".repeat(length), [RICH, PLAIN]).length).toBeLessThanOrEqual(
        TITLE_MAX,
      );
    }
  });

  it("works with a single suffix", () => {
    expect(fitTitle("News", [PLAIN])).toBe("News - OldSchoolGames");
    expect(fitTitle("w ".repeat(60).trim(), [PLAIN]).length).toBeLessThanOrEqual(
      TITLE_MAX,
    );
  });
});
