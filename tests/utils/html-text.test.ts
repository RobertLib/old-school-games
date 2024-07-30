import { describe, expect, it } from "vitest";
import {
  TITLE_MAX,
  decodeEntities,
  fitTitle,
  htmlToPlainText,
  truncateAtWord,
} from "../../utils/html-text";

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
