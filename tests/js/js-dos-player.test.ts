import { beforeEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/js-dos-player.js"),
  "utf-8",
);

const playerStylesheet = readFileSync(
  path.resolve(__dirname, "../../public/css/js-dos-player.css"),
  "utf-8",
);

/**
 * A window per case, rather than the one jsdom environment the other files
 * in here share.
 *
 * public/js/js-dos-player.js is not an IIFE like the rest of public/js — it
 * is a flat script whose top level declares `const stream`, `const
 * MEDIA_ORIGIN` and the rest — so running it twice in one realm is a
 * "has already been declared" SyntaxError before a single assertion. It also
 * reads its input from the URL it was loaded with and writes its output into
 * localStorage, both of which are properties of a window rather than of a
 * document. A fresh JSDOM gives each case its own of all three.
 *
 * The storage-refused cases below stand in for a browser in private mode or
 * with site data blocked, by making localStorage throw the way those do.
 */
const SITE = "https://oldschoolgames.eu";
const MEDIA = "https://trwglibsccninuamefls.supabase.co";
// A player origin of its own — PLAYER_ORIGIN in utils/site.ts. Any origin
// that is not the site's will do; the player cannot know which one it is on.
const PLAYER = "https://play.example.test";

const BUNDLE = `${MEDIA}/storage/v1/object/public/games/doom.jsdos`;

/**
 * What every frame the game page builds is opened with. The default for the
 * cases that are not about the address: the player now refuses to start an
 * empty emulator, so a fixture with no game would be testing the message
 * that replaces it rather than whatever the case is about.
 */
const WITH_BUNDLE = `?stream=${encodeURIComponent(BUNDLE)}`;

/**
 * The button is written here exactly as public/js-dos.html ships it —
 * aria-pressed="true" and "CRT: ON" — because that is the state the script
 * defaults to and the markup used to contradict it. A fixture that keeps the
 * old "OFF" would be testing a page that no longer exists, and it is the one
 * that hid the mismatch: every case here ran the script, which corrected the
 * label, so nothing here could tell the two apart. What still proves the
 * script ran is the crt-on class on #dos, which no markup carries.
 * tests/public-assets.test.ts is what holds the real file to the default.
 */
const PAGE = `<!doctype html><html><body>
  <div id="dos">
    <div id="crt-scanlines"></div>
    <button id="crt-btn" aria-pressed="true">CRT: ON</button>
  </div>
</body></html>`;

type Loaded = {
  window: Window &
    typeof globalThis & { Dos?: unknown; emulators?: Record<string, unknown> };
  dos: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
  setAutoSave: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  stored: () => string | null;
};

function load(
  options: {
    /** The query string the frame was opened with, "?stream=…" and all. */
    search?: string;
    /** The origin the player was served from: the site, or its own. */
    origin?: string;
    /** Whether the js-dos loader arrived at all. */
    dosLoaded?: boolean;
    /** An existing runtime, if js-dos has already loaded one. */
    runtime?: Record<string, unknown> | null;
    /** What the CRT preference was last stored as. */
    crt?: string;
    /** A sandboxed frame's storage: every access throws SecurityError. */
    blockStorage?: boolean;
    /**
     * The origin private file system js-dos saves into: there and answering,
     * there and refusing (Firefox's private mode), or not there at all.
     */
    opfs?: "available" | "refused" | "absent";
  } = {},
): Loaded {
  const {
    search = WITH_BUNDLE,
    origin = SITE,
    dosLoaded = true,
    runtime = null,
    crt,
    blockStorage = false,
    opfs = "available",
  } = options;

  const dom = new JSDOM(PAGE, {
    url: `${origin}/js-dos.html${search}`,
    runScripts: "outside-only",
  });

  const window = dom.window as unknown as Loaded["window"];

  if (crt !== undefined) window.localStorage.setItem("osg-crt", crt);

  // Read before the property is taken away, so the assertions can still see
  // what the script did or did not write.
  const storage = window.localStorage;

  if (blockStorage) {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new window.DOMException("denied", "SecurityError");
      },
    });
  }

  // jsdom has no StorageManager, so the file system is whatever the case
  // says it is.
  if (opfs !== "absent") {
    Object.defineProperty(window.navigator, "storage", {
      configurable: true,
      value: {
        getDirectory:
          opfs === "available"
            ? () => Promise.resolve({})
            : () =>
                Promise.reject(
                  new window.DOMException("denied", "SecurityError"),
                ),
      },
    });
  }

  const setFullScreen = vi.fn();
  const setAutoSave = vi.fn();
  const save = vi.fn(() => Promise.resolve(true));
  const dos = vi.fn(() => ({ setFullScreen, setAutoSave, save }));

  if (dosLoaded) window.Dos = dos;
  if (runtime) window.emulators = runtime;

  const error = vi.fn();
  window.console.error = error as unknown as Console["error"];

  window.eval(scriptContent);

  return {
    window,
    dos,
    setFullScreen,
    setAutoSave,
    save,
    error,
    stored: () => storage.getItem("osg-crt"),
  };
}

/** The options js-dos was started with, whatever they were. */
function dosOptions(loaded: Loaded): Record<string, unknown> {
  expect(loaded.dos).toHaveBeenCalledTimes(1);

  return loaded.dos.mock.calls[0]![1] as Record<string, unknown>;
}

/** Whatever #dos now says in place of the emulator, if anything. */
function shownMessage(loaded: Loaded): HTMLElement | null {
  return loaded.window.document.querySelector<HTMLElement>(
    '#dos [role="alert"]',
  );
}

/**
 * The address was missing or refused: no emulator, and a sentence in the
 * frame instead. Dos() used to be started anyway on `url: null`, which drew
 * an emulator with nothing in it and left the reason in the frame's console
 * — so a game whose stored address the player refuses looked, to the visitor,
 * exactly like a player that had hung.
 */
function expectNoGame(loaded: Loaded, reason: RegExp): void {
  const frame = loaded.window.document.getElementById("dos")!;

  expect(loaded.dos).not.toHaveBeenCalled();
  expect(frame.classList.contains("dos-no-game")).toBe(true);
  // Announced rather than merely present: the frame's first content is this
  // sentence, and role="alert" is what makes a screen reader say it.
  expect(shownMessage(loaded)?.textContent).toMatch(reason);
  // The CRT overlays and the toggle go with the emulator; a scanline filter
  // over an error message is nonsense.
  expect(loaded.window.document.getElementById("crt-btn")).toBeNull();
}

describe("js-dos-player.js — the game bundle in ?stream=", () => {
  /**
   * The value arrives in the query string, so it is checked before the
   * emulator is handed it. connect-src remains the control that actually
   * refuses a fetch from anywhere else — but a refused fetch is reported
   * nowhere except the browser console, so a crafted address got all the way
   * to Dos() and then failed with nothing on screen to say why.
   */
  it("passes a bundle from the media bucket through", () => {
    const loaded = load({ search: `?stream=${encodeURIComponent(BUNDLE)}` });

    expect(dosOptions(loaded).url).toBe(BUNDLE);
    expect(shownMessage(loaded)).toBeNull();
  });

  // validateGame accepts a relative path for "stream", so a bundle may be
  // served from this origin.
  it("resolves a relative bundle against this site", () => {
    const loaded = load({ search: "?stream=%2Fbundles%2Fdoom.jsdos" });

    expect(dosOptions(loaded).url).toBe(`${SITE}/bundles/doom.jsdos`);
  });

  it("says there is no game rather than starting an empty emulator", () => {
    expectNoGame(load({ search: "" }), /no game/i);
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["blob:", "blob:https://oldschoolgames.eu/whatever"],
  ])("refuses a %s bundle", (_label, value) => {
    // A "javascript:" or "data:" URL here would run inside the player's own
    // origin, which is the whole reason the scheme is checked.
    const loaded = load({ search: `?stream=${encodeURIComponent(value)}` });

    expectNoGame(loaded, /cannot be started/);
  });

  /**
   * Also the case a stored game reaches: an admin-entered bundle on a host
   * that is neither the site nor the bucket, which the player refuses
   * whatever validations/games.ts accepts — and now refuses visibly.
   */
  it("refuses a bundle from another site, and says so in the frame too", () => {
    const loaded = load({
      search: `?stream=${encodeURIComponent("https://evil.example/a.jsdos")}`,
    });

    expectNoGame(loaded, /cannot be started/);
    // And in the console, which is where the host it named is worth having.
    expect(loaded.error).toHaveBeenCalledWith(
      expect.stringContaining("https://evil.example"),
    );
  });

  it("refuses a bundle that is not a URL at all", () => {
    expectNoGame(
      load({ search: "?stream=http%3A%2F%2F%5B" }),
      /cannot be started/,
    );
  });
});

/**
 * The player on an origin of its own — PLAYER_ORIGIN — where its own origin
 * is no longer the site's, and SITE_ORIGIN is what it takes the site's word
 * by.
 */
describe("js-dos-player.js — served from a player origin", () => {
  it("accepts a game stored on the site", () => {
    // The page resolves a path on the site against the site before handing
    // it over, so this is how such a game arrives here.
    const url = `${SITE}/bundles/doom.jsdos`;
    const loaded = load({
      origin: PLAYER,
      search: `?stream=${encodeURIComponent(url)}`,
    });

    expect(dosOptions(loaded).url).toBe(url);
  });

  it("accepts a game from the media bucket", () => {
    const loaded = load({ origin: PLAYER });

    expect(dosOptions(loaded).url).toBe(BUNDLE);
  });

  it("still refuses a game from anywhere else", () => {
    const loaded = load({
      origin: PLAYER,
      search: `?stream=${encodeURIComponent("https://evil.example/a.jsdos")}`,
    });

    expectNoGame(loaded, /cannot be started/);
  });

  it("still says so when it is given no game", () => {
    expectNoGame(load({ origin: PLAYER, search: "" }), /no game/i);
  });
});

describe("js-dos-player.js — when the loader never arrived", () => {
  /**
   * The CDN can be down, an extension can block it, and a hash mismatch
   * makes the browser refuse the file outright. `Dos` is then undefined.
   *
   * The message that replaces the frame also removes every child of #dos —
   * the CRT overlays, the SVG filter and the toggle button — and the CRT
   * section below used to dereference that button a few lines later. The
   * TypeError took the message down with it: a black frame, nothing to
   * click, and one line in a console nobody has open.
   */
  it("explains itself instead of throwing", () => {
    const loaded = load({ dosLoaded: false });
    const frame = loaded.window.document.getElementById("dos")!;

    expect(frame.textContent).toContain("could not be loaded");
    expect(frame.classList.contains("dos-load-failed")).toBe(true);
    // Announced, like the no-game message: the same helper writes both.
    expect(shownMessage(loaded)?.textContent).toContain("could not be loaded");
    // The button the CRT code used to reach for unconditionally.
    expect(loaded.window.document.getElementById("crt-btn")).toBeNull();
  });

  // With no game to start there is nothing a working loader could do either,
  // so that is the sentence worth showing.
  it("says there is no game before it says there is no loader", () => {
    const loaded = load({ dosLoaded: false, search: "" });

    expect(shownMessage(loaded)?.textContent).toMatch(/no game/i);
  });

  it("lets js-dos load its own runtime without requiring a preload", () => {
    const loaded = load({ runtime: null });

    expect(loaded.dos).toHaveBeenCalledTimes(1);
    expect(shownMessage(loaded)).toBeNull();
  });

  it("leaves the keyboard shortcuts inert rather than broken", () => {
    const loaded = load({ dosLoaded: false });

    expect(() => {
      loaded.window.document.dispatchEvent(
        new loaded.window.KeyboardEvent("keydown", {
          key: "F7",
          altKey: true,
        }),
      );
    }).not.toThrow();
  });
});

describe("js-dos-player.js — the fullscreen relay", () => {
  function post(
    loaded: Loaded,
    overrides: { origin?: string; source?: unknown; data?: unknown } = {},
  ) {
    const { window } = loaded;

    window.dispatchEvent(
      new window.MessageEvent("message", {
        // "data" in overrides, not ??: the null case below is a message
        // that really carries nothing, and a ?? would hand it the default.
        data: "data" in overrides ? overrides.data : { action: "clickFullscreen" },
        origin: overrides.origin ?? SITE,
        source: (overrides.source === undefined
          ? window.parent
          : overrides.source) as MessageEventSource | null,
      }),
    );
  }

  /**
   * The game page addresses Alt+Enter to the player's origin; the receiving
   * end checks the same two things regardless — the message has to come
   * from the document that framed this one, and to carry the site's origin.
   */
  it("goes fullscreen for the framing page", () => {
    const loaded = load();

    post(loaded);

    expect(loaded.setFullScreen).toHaveBeenCalledWith(true);
  });

  it("ignores a message from anywhere but the parent", () => {
    const loaded = load();
    const frame = loaded.window.document.createElement("iframe");

    loaded.window.document.body.appendChild(frame);

    post(loaded, { source: frame.contentWindow });

    expect(loaded.setFullScreen).not.toHaveBeenCalled();
  });

  it("ignores a message with no source at all", () => {
    const loaded = load();

    post(loaded, { source: null });

    expect(loaded.setFullScreen).not.toHaveBeenCalled();
  });

  /**
   * The sender's origin is unaffected by this document's sandbox, so it is
   * still worth checking — against the site's origins, which are this
   * player's own and SITE_ORIGIN. The frame keeps a real origin, because its
   * sandbox carries allow-same-origin, so location.origin is not "null"
   * inside it.
   */
  it("ignores a message from another origin", () => {
    const loaded = load();

    post(loaded, { origin: "https://evil.example" });

    expect(loaded.setFullScreen).not.toHaveBeenCalled();
  });

  /**
   * On a player origin the page that frames the player is on the site, so
   * that is the origin its Alt+Enter arrives from — and the one the check
   * used to refuse, because it compared against the player's own.
   */
  it("goes fullscreen for a page on the site when served from a player origin", () => {
    const loaded = load({ origin: PLAYER });

    post(loaded, { origin: SITE });

    expect(loaded.setFullScreen).toHaveBeenCalledWith(true);
  });

  it("still ignores another origin when served from a player origin", () => {
    const loaded = load({ origin: PLAYER });

    post(loaded, { origin: "https://evil.example" });

    expect(loaded.setFullScreen).not.toHaveBeenCalled();
  });

  it("ignores a message that asks for something else", () => {
    const loaded = load();

    post(loaded, { data: { action: "somethingElse" } });

    expect(loaded.setFullScreen).not.toHaveBeenCalled();
  });

  it("survives a message carrying no data", () => {
    const loaded = load();

    expect(() => post(loaded, { data: null })).not.toThrow();
    expect(loaded.setFullScreen).not.toHaveBeenCalled();
  });

  // Alt+Enter inside the frame does the same thing without any message: the
  // relay exists only because the keystroke may land on the page instead.
  it("goes fullscreen on Alt+Enter inside the frame", () => {
    const loaded = load();

    loaded.window.document.dispatchEvent(
      new loaded.window.KeyboardEvent("keydown", {
        key: "Enter",
        altKey: true,
      }),
    );

    expect(loaded.setFullScreen).toHaveBeenCalledWith(true);
  });

  it("asks the parent to exit its fullscreen iframe on Alt+Enter", () => {
    const loaded = load({ origin: PLAYER });
    const send = vi.spyOn(loaded.window.parent, "postMessage");

    post(loaded, { data: { action: "frameFullscreen", active: true } });
    loaded.window.document.dispatchEvent(
      new loaded.window.KeyboardEvent("keydown", { key: "Enter", altKey: true }),
    );

    expect(send).toHaveBeenCalledWith({ action: "exitFrameFullscreen" }, SITE);
    expect(loaded.setFullScreen).not.toHaveBeenCalled();
  });

  it("uses native player fullscreen again after the parent's fullscreen ends", () => {
    const loaded = load({ origin: PLAYER });

    post(loaded, { data: { action: "frameFullscreen", active: true } });
    post(loaded, { data: { action: "frameFullscreen", active: false } });
    loaded.window.document.dispatchEvent(
      new loaded.window.KeyboardEvent("keydown", { key: "Enter", altKey: true }),
    );

    expect(loaded.setFullScreen).toHaveBeenCalledWith(true);
  });

  it.each([
    { origin: "https://evil.example" },
    { source: null },
    { data: { action: "frameFullscreen", active: "true" } },
  ])("ignores an untrusted or malformed fullscreen state: %j", (overrides) => {
    const loaded = load({ origin: PLAYER });

    post(loaded, { data: { action: "frameFullscreen", active: true }, ...overrides });
    loaded.window.document.dispatchEvent(
      new loaded.window.KeyboardEvent("keydown", { key: "Enter", altKey: true }),
    );

    expect(loaded.setFullScreen).toHaveBeenCalledWith(true);
  });

  it("saves once when outer fullscreen ends, including after duplicate state messages", async () => {
    const loaded = load({ origin: PLAYER });

    post(loaded, { data: { action: "frameFullscreen", active: true } });
    post(loaded, { data: { action: "frameFullscreen", active: true } });
    post(loaded, { data: { action: "frameFullscreen", active: false } });
    post(loaded, { data: { action: "frameFullscreen", active: false } });
    await Promise.resolve();
    await Promise.resolve();

    expect(loaded.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    { blockStorage: true },
    { opfs: "refused" as const },
    { opfs: "absent" as const },
  ])("does not save an outer fullscreen exit when storage is unavailable: %j", async (options) => {
    const loaded = load({ origin: PLAYER, ...options });

    post(loaded, { data: { action: "frameFullscreen", active: true } });
    post(loaded, { data: { action: "frameFullscreen", active: false } });
    await Promise.resolve();
    await Promise.resolve();

    expect(loaded.save).not.toHaveBeenCalled();
  });

  it("leaves native fullscreen autosave to js-dos when the child also went fullscreen", async () => {
    const loaded = load({ origin: PLAYER });

    post(loaded, { data: { action: "frameFullscreen", active: true } });
    Object.defineProperty(loaded.window.document, "fullscreenElement", {
      configurable: true,
      value: loaded.window.document.getElementById("dos"),
    });
    loaded.window.document.dispatchEvent(new loaded.window.Event("fullscreenchange"));
    Object.defineProperty(loaded.window.document, "fullscreenElement", { value: null });
    loaded.window.document.dispatchEvent(new loaded.window.Event("fullscreenchange"));
    post(loaded, { data: { action: "frameFullscreen", active: false } });
    await Promise.resolve();
    await Promise.resolve();

    expect(loaded.save).not.toHaveBeenCalled();
  });

  it("saves later changes when the toolbar left native fullscreen but the outer frame remains fullscreen", async () => {
    const loaded = load({ origin: PLAYER });
    const send = vi.spyOn(loaded.window.parent, "postMessage");

    post(loaded, { data: { action: "frameFullscreen", active: true } });
    Object.defineProperty(loaded.window.document, "fullscreenElement", {
      configurable: true,
      value: loaded.window.document.getElementById("dos"),
    });
    loaded.window.document.dispatchEvent(new loaded.window.Event("fullscreenchange"));
    Object.defineProperty(loaded.window.document, "fullscreenElement", { value: null });
    loaded.window.document.dispatchEvent(new loaded.window.Event("fullscreenchange"));
    expect(send).toHaveBeenCalledWith({ action: "getFrameFullscreen" }, SITE);

    // The parent's answer distinguishes leaving only the inner layer from
    // leaving both. Re-arm saving for play that continues in the outer frame.
    post(loaded, { data: { action: "frameFullscreen", active: true } });
    post(loaded, { data: { action: "frameFullscreen", active: false } });
    await Promise.resolve();
    await Promise.resolve();

    expect(loaded.save).toHaveBeenCalledTimes(1);
  });
});

describe("js-dos-player.js — the CRT filter", () => {
  function button(loaded: Loaded): HTMLButtonElement {
    return loaded.window.document.getElementById(
      "crt-btn",
    ) as HTMLButtonElement;
  }

  function isOn(loaded: Loaded): boolean {
    return loaded.window.document
      .getElementById("dos")!
      .classList.contains("crt-on");
  }

  it("is on for a visitor who has never chosen", () => {
    const loaded = load();

    expect(isOn(loaded)).toBe(true);
    expect(button(loaded).textContent).toBe("CRT: ON");
    expect(button(loaded).getAttribute("aria-pressed")).toBe("true");
  });

  it("stays off for a visitor who turned it off", () => {
    const loaded = load({ crt: "0" });

    expect(isOn(loaded)).toBe(false);
    expect(button(loaded).textContent).toBe("CRT: OFF");
    // The stored "0" has to reach the attribute as well as the label — this
    // is the case the markup's own aria-pressed="true" is wrong for, so it is
    // the one that shows setCRT is writing it rather than the page.
    expect(button(loaded).getAttribute("aria-pressed")).toBe("false");
  });

  /**
   * Loading is not choosing. setCRT used to write on every load, so a
   * visitor who had never touched the toggle had the default stored for them
   * on their first visit — and the stored value then looked exactly like a
   * decision.
   */
  it("stores nothing until the visitor touches it", () => {
    const loaded = load();

    expect(loaded.stored()).toBeNull();
  });

  it("remembers the choice made with the button", () => {
    const loaded = load();

    button(loaded).click();

    expect(isOn(loaded)).toBe(false);
    expect(button(loaded).textContent).toBe("CRT: OFF");
    // A toggle button says which way it is set in aria-pressed, not only in
    // its label; a screen reader reading "CRT: ON" off a plain button hears a
    // command rather than a state.
    expect(button(loaded).getAttribute("aria-pressed")).toBe("false");
    expect(loaded.stored()).toBe("0");

    button(loaded).click();

    expect(isOn(loaded)).toBe(true);
    expect(button(loaded).getAttribute("aria-pressed")).toBe("true");
    expect(loaded.stored()).toBe("1");
  });

  // Works in fullscreen too, which is why it is a document-level shortcut.
  it("remembers the choice made with Alt+F7", () => {
    const loaded = load();

    loaded.window.document.dispatchEvent(
      new loaded.window.KeyboardEvent("keydown", { key: "F7", altKey: true }),
    );

    expect(isOn(loaded)).toBe(false);
    // The shortcut goes through setCRT like the click does, so it moves the
    // attribute too — it was the path most likely to be left behind.
    expect(button(loaded).getAttribute("aria-pressed")).toBe("false");
    expect(loaded.stored()).toBe("0");
  });
});

describe("js-dos-player.js — when storage is refused", () => {
  /**
   * Private mode, or site data blocked: every storage API throws rather than
   * answering. The player has no business failing to start a game over a
   * display toggle, so both accesses are wrapped — and js-dos is told up
   * front that there is no storage, because its autoSave would otherwise
   * raise that SecurityError deep inside the emulator where nothing here can
   * catch it.
   */
  it("still starts the game", () => {
    const loaded = load({ blockStorage: true });

    expect(loaded.dos).toHaveBeenCalledTimes(1);
  });

  it("switches js-dos autoSave off rather than letting it throw", () => {
    expect(dosOptions(load({ blockStorage: true })).autoSave).toBe(false);
  });

  it("keeps autoSave where storage does work", async () => {
    const loaded = load();

    expect(dosOptions(loaded).autoSave).toBe(true);

    // And leaves it on once the file system has answered too.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded.setAutoSave).not.toHaveBeenCalled();
  });

  /**
   * js-dos 8.4 and later save into the origin private file system, not
   * localStorage — and Firefox's private mode keeps the one while refusing
   * the other. localStorage alone said "yes" there, autoSave stayed on, and
   * every autosave ended in js-dos's "unable to save" toast. The game is not
   * held back for the answer: it starts, and autoSave goes off once the
   * file system has said no.
   */
  it.each(["refused", "absent"] as const)(
    "switches autoSave off once the file system is %s",
    async (opfs) => {
      const loaded = load({ opfs });

      expect(loaded.dos).toHaveBeenCalledTimes(1);

      await vi.waitFor(() => {
        expect(loaded.setAutoSave).toHaveBeenCalledWith(false);
      });
    },
  );

  // Nothing to switch off: it was started with autoSave off already.
  it("asks js-dos nothing more where localStorage is refused", async () => {
    const loaded = load({ blockStorage: true, opfs: "refused" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loaded.setAutoSave).not.toHaveBeenCalled();
  });

  it("still shows and toggles the filter, it just cannot remember it", () => {
    const loaded = load({ blockStorage: true });
    const crtBtn = loaded.window.document.getElementById(
      "crt-btn",
    ) as HTMLButtonElement;

    expect(crtBtn.textContent).toBe("CRT: ON");

    expect(() => crtBtn.click()).not.toThrow();
    expect(crtBtn.textContent).toBe("CRT: OFF");
    expect(crtBtn.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("js-dos-player.js — how the emulator is started", () => {
  it("pins the emulator runtime to the release the page loads", () => {
    const options = dosOptions(load());

    // A loader and an emulator runtime from different builds is not a
    // combination anyone tests; tests/public-assets.test.ts is what keeps
    // this version in step with public/js-dos.html, app.ts and the copy
    // package.json installs.
    expect(options.pathPrefix).toMatch(
      new RegExp(
        `^${SITE.replace(/[.]/g, "\\.")}/vendor/js-dos/\\d+\\.\\d+\\.\\d+/emulators/$`,
      ),
    );
  });

  it("loads the emulator runtime from the origin that served the frame", () => {
    // Absolute, because emulators.js starts DOSBox in a worker built from a
    // blob: URL, where a bare "/vendor/…" path has no host to resolve
    // against. And the frame's own origin rather than the site's: on a
    // player origin, 'self' in the player's policy is the player origin,
    // which is what serves these files there.
    const onPlayerOrigin = dosOptions(
      load({ origin: "https://play.example.com" }),
    );

    expect(onPlayerOrigin.pathPrefix).toMatch(
      /^https:\/\/play\.example\.com\/vendor\/js-dos\/[^/]+\/emulators\/$/,
    );
  });

  it("starts on its own and captures the mouse", () => {
    const options = dosOptions(load());

    expect(options.autoStart).toBe(true);
    expect(options.mouseCapture).toBe(true);
  });
});

describe("js-dos-player.js — default audio", () => {
  it.each([
    "dosboxWorker",
    "dosboxDirect",
    "dosboxXWorker",
    "dosboxXDirect",
    "dosboxXJspiWorker",
    "dosboxXJspiDirect",
  ])("leaves %s and its audio options to js-dos", (name) => {
    const start = vi.fn();
    const runtime = { [name]: start, pathPrefix: "", pathSuffix: "?pinned" };
    const loaded = load({ runtime, origin: PLAYER });

    // The former factory wrapper forced audioWorklet=false, putting sound
    // processing back on the UI thread even when js-dos requested a worklet.
    expect(loaded.window.emulators![name]).toBe(start);
    expect(dosOptions(loaded)).not.toHaveProperty("audioWorklet");
    expect(runtime.pathPrefix).toBe("");
    expect(runtime.pathSuffix).toBe("?pinned");
  });
});

describe("js-dos-player.css — emulator messages", () => {
  /**
   * The wrappers are the markup from js-dos 8.4.1's ClickToLock, ModalText
   * (src/window/dos/dos-window.tsx) and Toast (src/ui.tsx), available in its
   * distributed source map. They share pointer-events-none because none
   * should intercept a canvas click, but only the mouse hints should be
   * hidden. In particular apiSave uses the error toast for failed saves.
   * Checking computed display catches the old rule hiding its ancestor,
   * rather than just checking that "Unable to save" exists in the document.
   */
  const fixtures = [
    {
      label: "failed-save toast",
      classes: "absolute right-10 bottom-10 pointer-events-none opacity-80",
      content: '<div class="alert alert-error text-error-content"><span class="break-words">Unable to save</span></div>',
      display: "block",
    },
    {
      label: "save-warning toast",
      classes: "absolute right-10 bottom-10 pointer-events-none opacity-80",
      content: '<div class="alert alert-warning text-warning-content"><span class="break-words">Saved in browser (not logged in)</span></div>',
      display: "block",
    },
    {
      label: "loading/error modal text",
      classes: "absolute top-0 left-0 w-full h-full flex flex-row items-center justify-center pointer-events-none bg-black/70 gap-2 px-4 py-2 text-white text-center",
      content: '<div class="text-4xl">Unable to connect to network</div>',
      display: "block",
    },
    {
      label: "modal pointer-lock hint",
      classes: "absolute top-0 left-0 w-full h-full flex flex-col items-center justify-center pointer-events-none bg-black/70 gap-2 px-4 py-2 text-white text-center",
      content: '<div class="text-4xl">Click to capture mouse</div><div class="text-xl">Use `Esc` to unlock</div>',
      display: "none",
    },
    {
      label: "floating pointer-lock hint",
      classes: "absolute top-6 left-0 w-full pointer-events-none flex flex-row items-center justify-center",
      content: '<div class="flex flex-col items-center justify-center bg-black/70 gap-2 px-4 py-2 text-white text-center rounded-lg"><div class="text-4xl">Click to capture mouse</div></div>',
      display: "none",
    },
  ];

  it.each(fixtures)("keeps the intended display for $label", (fixture) => {
    const dom = new JSDOM(`<!doctype html><html><head>
      <style>${playerStylesheet}</style>
      </head><body><div id="dos">
      <div id="message" class="${fixture.classes}">${fixture.content}</div>
      </div></body></html>`);

    try {
      const message = dom.window.document.getElementById("message")!;
      expect(dom.window.getComputedStyle(message).display).toBe(fixture.display);
      expect(dom.window.getComputedStyle(message.parentElement!).display).not.toBe(
        "none",
      );
    } finally {
      dom.window.close();
    }
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
