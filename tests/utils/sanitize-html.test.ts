import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../../utils/sanitize-html.ts";

/**
 * The one place in the app that decides what author-supplied markup may
 * contain.
 *
 * Game descriptions and news articles are the only two things stored as
 * markup, both are written by an administrator, and both are rendered with
 * <%- %> — so what this leaves in is what a visitor's browser runs. It was
 * called with no configuration at all until now, which meant its behaviour
 * was DOMPurify's default and could change with a dependency bump without a
 * line of this repository changing.
 */
describe("sanitizeHtml", () => {
  describe("keeps the markup an article is actually written in", () => {
    it.each([
      ["a paragraph", "<p>Sam &amp; Max hit the road.</p>"],
      ["emphasis", "<p><strong>Doom</strong> and <em>Quake</em></p>"],
      ["a line break", "One<br>two"],
      ["a list", "<ul><li>One</li><li>Two</li></ul>"],
      ["a heading", "<h2>The plot</h2>"],
      ["a table", "<table><tbody><tr><td>1993</td></tr></tbody></table>"],
      ["an image", '<img src="/covers/doom.png" alt="Doom">'],
      ["a link", '<a href="https://example.com/x">x</a>'],
    ])("leaves %s alone", (_label, html) => {
      expect(sanitizeHtml(html)).toBe(html);
    });

    /**
     * Both models sanitize on the way in and one route sanitizes before it
     * measures a length, so the same text goes through this twice. An "&"
     * held as "&amp;" must not become "&amp;amp;" on the second pass — the
     * reader would see the entity.
     */
    it("is idempotent", () => {
      const once = sanitizeHtml("<p>Sam & Max</p><p>Classic.</p>");

      expect(sanitizeHtml(once)).toBe(once);
    });
  });

  describe("strips what can run", () => {
    it("removes a script", () => {
      expect(sanitizeHtml("<p>Safe</p><script>alert(1)</script>")).toBe(
        "<p>Safe</p>",
      );
    });

    it("removes an event handler but keeps the element", () => {
      expect(sanitizeHtml('<img src="x" onerror="alert(1)">')).toBe(
        '<img src="x">',
      );
    });

    it("removes a javascript: link target", () => {
      expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe(
        "<a>x</a>",
      );
    });

    // Already stripped before this function took a configuration, and
    // asserted so that the FORBID_TAGS list is not read as the whole story.
    it.each([
      ["an iframe", '<iframe src="https://evil.example"></iframe>'],
      ["an object", '<object data="x.swf"></object>'],
      ["an embed", '<embed src="x.swf">'],
      ["a base tag", '<base href="https://evil.example/">'],
    ])("removes %s", (_label, html) => {
      expect(sanitizeHtml(`<p>Safe</p>${html}`)).toBe("<p>Safe</p>");
    });
  });

  /**
   * The half no XSS filter objects to, and the reason this function now
   * passes a configuration.
   *
   * A <form> inside an article renders a login box that posts wherever its
   * action says, on a page carrying the site's own chrome, and a visitor
   * cannot tell it from the real thing. Every tag here is inert by
   * DOMPurify's measure and none of them belongs in stored content.
   */
  describe("strips the controls that could impersonate the site", () => {
    it("removes a form and keeps what was inside it", () => {
      const html = sanitizeHtml(
        '<form action="https://evil.example"><p>Sign in</p></form>',
      );

      expect(html).not.toContain("<form");
      expect(html).toContain("<p>Sign in</p>");
    });

    it.each([
      ["an input", '<input name="password" type="password">'],
      ["a button", "<button>Sign in</button>"],
      ["a textarea", "<textarea></textarea>"],
      ["a select", "<select><option>One</option></select>"],
    ])("removes %s", (_label, html) => {
      const sanitized = sanitizeHtml(`<p>Safe</p>${html}`);

      expect(sanitized).toContain("<p>Safe</p>");
      expect(sanitized).not.toMatch(/<(input|button|textarea|select|option)/);
    });
  });

  /**
   * Out of the box DOMPurify also permits SVG and MathML. Nothing here
   * stores either, and SVG is a document format of its own with a history of
   * sanitizer bypasses — so the html profile narrows it to the one language
   * this app has content in.
   */
  describe("allows no markup language but HTML", () => {
    it("removes an SVG", () => {
      const html = sanitizeHtml('<p>Safe</p><svg><circle r="1"/></svg>');

      expect(html).toContain("<p>Safe</p>");
      expect(html).not.toContain("<svg");
      expect(html).not.toContain("<circle");
    });

    it("removes MathML", () => {
      const html = sanitizeHtml("<p>Safe</p><math><mi>x</mi></math>");

      expect(html).toContain("<p>Safe</p>");
      expect(html).not.toContain("<math");
    });
  });

  it("answers an empty string with an empty string", () => {
    expect(sanitizeHtml("")).toBe("");
  });

  it("keeps bare text rather than dropping it", () => {
    expect(sanitizeHtml("Sam & Max")).toBe("Sam & Max");
  });

  /**
   * DOMPurify allows <style> and sanitizes the CSS inside it, so this is a
   * decision of this app's rather than a default inherited: CSS is an
   * exfiltration channel that needs no script, and "style-src" in app.ts is
   * the only thing refusing a stored <style> today.
   */
  it("removes a style block, which DOMPurify would keep", () => {
    const html = sanitizeHtml("<p>Safe</p><style>body{display:none}</style>");

    expect(html).toContain("<p>Safe</p>");
    expect(html).not.toContain("<style");
  });
});
