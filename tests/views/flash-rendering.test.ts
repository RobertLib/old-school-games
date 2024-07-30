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

  /**
   * The third column is the live-region role, and it is not the same for all
   * four. "status" is polite — a screen reader finishes its current sentence
   * before reading it — which is right for a success and wrong for the one
   * message that says the thing the visitor asked for did not happen, so a
   * failure gets the assertive "alert" instead.
   */
  it.each([
    ["error", "alert-danger", "alert"],
    ["success", "alert-success", "status"],
    ["warning", "alert-warning", "status"],
    ["info", "alert-info", "status"],
  ])("styles a %s flash as %s with role=%s", async (type, className, role) => {
    const [alert] = alerts(await render({ [type]: ["Hello"] }));

    expect(alert).toBeDefined();
    expect(alert!.classList.contains(className)).toBe(true);
    expect(alert!.textContent).toBe("Hello");
    expect(alert!.getAttribute("role")).toBe(role);
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
