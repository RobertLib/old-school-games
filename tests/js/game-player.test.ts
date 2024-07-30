/**
 * @vitest-environment jsdom
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/game-player.js"),
  "utf-8",
);

declare const window: Window &
  typeof globalThis & {
    GamePlayer: { start: (player: Element | null) => boolean; init: () => void };
    addGameToRecentlyPlayed?: (id: string) => void;
  };

const fetchMock = vi.fn(() => Promise.resolve({ ok: true }));

function mount(options: { cover?: boolean; hero?: boolean } = {}) {
  document.head.innerHTML = `<meta name="csrf-token" content="tok123">`;
  document.body.innerHTML = `
    ${options.hero ? '<a class="btn game-hero-play" href="#just-play-it">Play now</a>' : ""}
    <div class="game-detail-player" data-game-id="42" data-player-src="/js-dos.html?stream=x" data-title="Doom">
      <button class="game-detail-poster" type="button"${options.cover ? ' style="background-image: url(c.png)"' : ""}>
        <span class="game-detail-poster-label">Click to play</span>
      </button>
    </div>
  `;
  window.GamePlayer.init();
}

beforeAll(() => {
  vi.stubGlobal("fetch", fetchMock);
  // eslint-disable-next-line no-eval
  (0, eval)(scriptContent);
});

beforeEach(() => {
  fetchMock.mockClear();
  delete window.addGameToRecentlyPlayed;
});

/**
 * The emulator used to boot on page load and the play was counted on the
 * frame's load event — so a visitor who read the description and left had
 * "played" the game. Now nothing happens until the poster is clicked.
 */
describe("game-player.js", () => {
  it("does nothing on a page without a player", () => {
    document.body.innerHTML = "<p>no game here</p>";

    expect(() => window.GamePlayer.init()).not.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates no frame and records no play until the poster is clicked", () => {
    mount();

    expect(document.querySelector(".game-detail-stream")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("swaps the poster for the frame on click", () => {
    mount({ cover: true });

    (document.querySelector(".game-detail-poster") as HTMLButtonElement).click();

    const frame = document.querySelector<HTMLIFrameElement>(".game-detail-stream");

    expect(document.querySelector(".game-detail-poster")).toBeNull();
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("src")).toBe("/js-dos.html?stream=x");
    expect(frame!.title).toBe("Doom");
  });

  /**
   * The frame the script builds carries the same two attributes the
   * <noscript> one in views/games/game-detail.ejs does — the emulator is
   * third-party code running with 'unsafe-eval', and a policy says what it
   * may load while the sandbox fences in what its ordinary code does. The
   * sandbox is a boundary against code that means harm only when the
   * address is a player origin of its own; that comment has the long
   * version.
   */
  describe("the frame it builds is sandboxed", () => {
    function frame(): HTMLIFrameElement {
      mount();
      (document.querySelector(".game-detail-poster") as HTMLButtonElement).click();

      return document.querySelector<HTMLIFrameElement>(".game-detail-stream")!;
    }

    it("gives it only what a DOS game uses", () => {
      expect(frame().getAttribute("sandbox")).toBe(
        "allow-scripts allow-same-origin allow-pointer-lock",
      );
    });

    /**
     * Kept on purpose: in an opaque origin js-dos can neither save a game
     * nor reach its own cache, and the player's own files are refused by
     * Cross-Origin-Resource-Policy. What the sandbox withholds instead is
     * navigation, popups and forms — from the emulator's ordinary code; a
     * same-origin frame that means harm can lift the sandbox, which is what
     * a player origin of its own is for.
     */
    it("keeps it on its origin but withholds navigation and popups", () => {
      const sandbox = frame().getAttribute("sandbox") ?? "";

      expect(sandbox).toContain("allow-same-origin");
      expect(sandbox).not.toContain("allow-top-navigation");
      expect(sandbox).not.toContain("allow-popups");
    });

    it("passes through the features the emulator needs", () => {
      expect(frame().getAttribute("allow")).toBe(
        "fullscreen; gamepad; autoplay",
      );
    });

    /**
     * A sandbox applied after the document has started loading does not
     * apply to it, so the attribute has to be set before .src. Asserted
     * through the source rather than the DOM, because jsdom loads nothing
     * and would be just as happy with the wrong order.
     */
    it("sets the sandbox before the address", () => {
      expect(scriptContent.indexOf('"sandbox"')).toBeLessThan(
        scriptContent.indexOf("iframe.src = src"),
      );
    });

    /**
     * With PLAYER_ORIGIN set the page hands this script an absolute address
     * on the player's origin. It has to arrive in the frame untouched, and
     * under the same sandbox — on that origin allow-same-origin keeps the
     * player's origin rather than this site's, which is what makes the same
     * tokens a boundary there.
     */
    it("frames a player origin of its own the same way", () => {
      const address =
        "https://play.example.test/js-dos.html?v=abc&stream=https%3A%2F%2Foldschoolgames.eu%2Fdoom.jsdos";

      mount();
      document
        .querySelector<HTMLElement>(".game-detail-player")!
        .setAttribute("data-player-src", address);
      (document.querySelector(".game-detail-poster") as HTMLButtonElement).click();

      const built = document.querySelector<HTMLIFrameElement>(
        ".game-detail-stream",
      )!;

      expect(built.getAttribute("src")).toBe(address);
      expect(built.getAttribute("sandbox")).toBe(
        "allow-scripts allow-same-origin allow-pointer-lock",
      );
    });
  });

  it("records the play with the CSRF token when the game starts", () => {
    mount();

    (document.querySelector(".game-detail-poster") as HTMLButtonElement).click();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/games/42/play",
      expect.objectContaining({
        method: "POST",
        headers: { "x-csrf-token": "tok123" },
      }),
    );
  });

  it("adds the game to the recently-played list when the helper is present", () => {
    const recent = vi.fn();
    window.addGameToRecentlyPlayed = recent;
    mount();

    (document.querySelector(".game-detail-poster") as HTMLButtonElement).click();

    expect(recent).toHaveBeenCalledWith("42");
  });

  it("counts a play once, however many times it is asked to start", () => {
    mount({ hero: true });

    (document.querySelector(".game-detail-poster") as HTMLButtonElement).click();
    (document.querySelector(".game-hero-play") as HTMLAnchorElement).click();

    expect(document.querySelectorAll(".game-detail-stream")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("starts the game from the hero's Play now link too", () => {
    mount({ hero: true });

    (document.querySelector(".game-hero-play") as HTMLAnchorElement).click();

    expect(document.querySelector(".game-detail-stream")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses to start a player with no frame address", () => {
    mount();
    const player = document.querySelector<HTMLElement>(".game-detail-player")!;
    delete player.dataset.playerSrc;

    expect(window.GamePlayer.start(player)).toBe(false);
    expect(document.querySelector(".game-detail-stream")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("survives a failed play request", async () => {
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("offline")));
    mount();

    (document.querySelector(".game-detail-poster") as HTMLButtonElement).click();

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.querySelector(".game-detail-stream")).not.toBeNull();
  });
});
