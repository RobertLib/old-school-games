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
