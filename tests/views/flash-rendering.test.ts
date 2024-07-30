/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import ejs from "ejs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIEW = path.resolve(__dirname, "../../views/flash.ejs");

function render(
  flash: Record<string, string[]>,
  user: object | null = { id: 1 },
): Promise<string> {
  const req = {
    session: user ? { user } : {},
    flash: () => flash,
  };

  return ejs.renderFile(VIEW, { req });
}

function alerts(html: string): HTMLElement[] {
  document.body.innerHTML = html;

  return Array.from(document.querySelectorAll<HTMLElement>(".alert"));
}

/**
 * The partial used to print the raw flash type as the class — which the
 * stylesheet does not know — and the message array itself, so two messages
 * of one type came out joined by a comma and every type looked the same.
 */
describe("flash.ejs", () => {
  it("renders nothing for a visitor who is not signed in", async () => {
    expect((await render({ error: ["Nope"] }, null)).trim()).toBe("");
  });

  it.each([
    ["error", "alert-danger"],
    ["success", "alert-success"],
    ["warning", "alert-warning"],
    ["info", "alert-info"],
  ])("styles a %s flash as %s", async (type, className) => {
    const [alert] = alerts(await render({ [type]: ["Hello"] }));

    expect(alert).toBeDefined();
    expect(alert!.classList.contains(className)).toBe(true);
    expect(alert!.textContent).toBe("Hello");
    expect(alert!.getAttribute("role")).toBe("status");
  });

  it("falls back to the neutral style for a type it does not know", async () => {
    const [alert] = alerts(await render({ weird: ["?"] }));

    expect(alert!.classList.contains("alert-info")).toBe(true);
  });

  it("renders one alert per message", async () => {
    const found = alerts(
      await render({ success: ["Saved.", "And again."], error: ["Nope."] }),
    );

    expect(found.map((el) => el.textContent)).toEqual([
      "Saved.",
      "And again.",
      "Nope.",
    ]);
  });

  it("escapes the message", async () => {
    const [alert] = alerts(await render({ error: ["<img src=x onerror=1>"] }));

    expect(alert!.querySelector("img")).toBeNull();
    expect(alert!.textContent).toBe("<img src=x onerror=1>");
  });
});
