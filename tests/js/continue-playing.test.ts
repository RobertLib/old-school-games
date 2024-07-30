import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const template = readFileSync(
  path.resolve(__dirname, "../../views/continue-playing.ejs"),
  "utf-8",
);

// The reservation logic lives inline in the template so it runs during parse,
// before anything below it has been laid out.
// EJS tags go first, then the script is matched. The opening tag carries
// nonce="<%= cspNonce %>" — so the CSP can name this block rather than allow
// inline script site-wide — and that attribute value contains a ">" of its
// own, which any [^>]* would stop at, capturing a fragment of the tag as if
// it were the script.
const inlineScript = template
  .replace(/<%[\s\S]*?%>/g, "")
  .match(/<script[^>]*>([\s\S]*?)<\/script>/)![1];

const MARKUP = `<!doctype html><html><body>
  <section class="continue-playing" id="continue-playing" hidden>
    <header class="continue-playing-header"><h2>Continue playing</h2></header>
    <div class="continue-playing-list" id="continue-playing-list"></div>
  </section>
</body></html>`;

function run(storedValue?: string) {
  const dom = new JSDOM(MARKUP, {
    runScripts: "outside-only",
    url: "http://localhost/",
  });

  if (storedValue !== undefined) {
    dom.window.localStorage.setItem("recentlyPlayedGames", storedValue);
  }

  dom.window.eval(inlineScript);

  const doc = dom.window.document;

  return {
    section: doc.getElementById("continue-playing") as HTMLElement,
    placeholders: doc.querySelectorAll(".continue-playing-card.is-placeholder"),
  };
}

describe("continue-playing.ejs — space reservation", () => {
  it("stays hidden when nothing has been played", () => {
    const { section, placeholders } = run();

    expect(section.hidden).toBe(true);
    expect(placeholders).toHaveLength(0);
  });

  it("stays hidden for an empty stored list", () => {
    const { section, placeholders } = run("[]");

    expect(section.hidden).toBe(true);
    expect(placeholders).toHaveLength(0);
  });

  it("reserves one placeholder per stored game", () => {
    const { section, placeholders } = run(
      JSON.stringify([{ id: "1" }, { id: "2" }, { id: "3" }]),
    );

    // Without this the real cards arrive after the fetch and shove the rest
    // of the homepage down.
    expect(section.hidden).toBe(false);
    expect(placeholders).toHaveLength(3);
  });

  it("reserves at most four, matching what the list renders", () => {
    const { placeholders } = run(
      JSON.stringify([1, 2, 3, 4, 5, 6].map((id) => ({ id: String(id) }))),
    );

    expect(placeholders).toHaveLength(4);
  });

  it("gives each placeholder the same inner boxes as a real card", () => {
    const { placeholders } = run(JSON.stringify([{ id: "1" }]));

    const card = placeholders[0] as HTMLElement;
    expect(card.querySelector(".continue-playing-image")).not.toBeNull();
    expect(card.querySelector(".continue-playing-name")).not.toBeNull();
    expect(card.getAttribute("aria-hidden")).toBe("true");
  });

  it("survives corrupted localStorage without throwing", () => {
    expect(() => run("{not json")).not.toThrow();
    expect(run("{not json").section.hidden).toBe(true);
  });

  it("survives a stored value that is not an array", () => {
    const { section } = run(JSON.stringify({ id: "1" }));

    expect(section.hidden).toBe(true);
  });
});
