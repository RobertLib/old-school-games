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

const PAGE = `<!doctype html><html><body>
  <div id="dos">
    <div id="crt-scanlines"></div>
    <button id="crt-btn">CRT: OFF</button>
  </div>
</body></html>`;

type Loaded = {
  window: Window & typeof globalThis & { Dos?: unknown };
  dos: ReturnType<typeof vi.fn>;
  setFullScreen: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  stored: () => string | null;
};

function load(
  options: {
    /** The query string the frame was opened with, "?stream=…" and all. */
    search?: string;
    /** Whether the js-dos loader arrived at all. */
    dosLoaded?: boolean;
    /** What the CRT preference was last stored as. */
    crt?: string;
    /** A sandboxed frame's storage: every access throws SecurityError. */
    blockStorage?: boolean;
  } = {},
): Loaded {
  const { search = "", dosLoaded = true, crt, blockStorage = false } = options;

  const dom = new JSDOM(PAGE, {
    url: `${SITE}/js-dos.html${search}`,
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

  const setFullScreen = vi.fn();
  const dos = vi.fn(() => ({ setFullScreen }));

  if (dosLoaded) window.Dos = dos;

  const error = vi.fn();
  window.console.error = error as unknown as Console["error"];

  window.eval(scriptContent);

  return {
    window,
    dos,
    setFullScreen,
    error,
    stored: () => storage.getItem("osg-crt"),
  };
}

/** The options js-dos was started with, whatever they were. */
function dosOptions(loaded: Loaded): Record<string, unknown> {
  expect(loaded.dos).toHaveBeenCalledTimes(1);

  return loaded.dos.mock.calls[0]![1] as Record<string, unknown>;
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
    const url = `${MEDIA}/storage/v1/object/public/games/doom.jsdos`;
    const loaded = load({ search: `?stream=${encodeURIComponent(url)}` });

    expect(dosOptions(loaded).url).toBe(url);
  });

  // validateGame accepts a relative path for "stream", so a bundle may be
  // served from this origin.
  it("resolves a relative bundle against this site", () => {
    const loaded = load({ search: "?stream=%2Fbundles%2Fdoom.jsdos" });

    expect(dosOptions(loaded).url).toBe(`${SITE}/bundles/doom.jsdos`);
  });

  it("starts with no bundle at all when none was asked for", () => {
    expect(dosOptions(load()).url).toBeNull();
  });

  it.each([
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,<script>alert(1)</script>"],
    ["blob:", "blob:https://oldschoolgames.eu/whatever"],
  ])("refuses a %s bundle", (_label, value) => {
    // A "javascript:" or "data:" URL here would run inside the player's own
    // origin, which is the whole reason the scheme is checked.
    const loaded = load({ search: `?stream=${encodeURIComponent(value)}` });

    expect(dosOptions(loaded).url).toBeNull();
  });

  it("refuses a bundle from another site, and says so", () => {
    const loaded = load({
      search: `?stream=${encodeURIComponent("https://evil.example/a.jsdos")}`,
    });

    expect(dosOptions(loaded).url).toBeNull();
    // Said out loud, because the symptom on its own — a player that loads
    // and never starts a game — looks like half a dozen other failures.
    expect(loaded.error).toHaveBeenCalledWith(
      expect.stringContaining("https://evil.example"),
    );
  });

  it("refuses a bundle that is not a URL at all", () => {
    const loaded = load({ search: "?stream=http%3A%2F%2F%5B" });

    expect(dosOptions(loaded).url).toBeNull();
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
    // The button the CRT code used to reach for unconditionally.
    expect(loaded.window.document.getElementById("crt-btn")).toBeNull();
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
   * The game page addresses Alt+Enter to this origin; the receiving end
   * checks the same two things regardless — the message has to come from
   * the document that framed this one, and to carry this site's origin.
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
   * still worth checking — and it is checked against the origin this player
   * was served from rather than against window.location.origin, which reads
   * "null" inside the frame.
   */
  it("ignores a message from another origin", () => {
    const loaded = load();

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
  });

  it("stays off for a visitor who turned it off", () => {
    const loaded = load({ crt: "0" });

    expect(isOn(loaded)).toBe(false);
    expect(button(loaded).textContent).toBe("CRT: OFF");
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
    expect(loaded.stored()).toBe("0");

    button(loaded).click();

    expect(isOn(loaded)).toBe(true);
    expect(loaded.stored()).toBe("1");
  });

  // Works in fullscreen too, which is why it is a document-level shortcut.
  it("remembers the choice made with Alt+F7", () => {
    const loaded = load();

    loaded.window.document.dispatchEvent(
      new loaded.window.KeyboardEvent("keydown", { key: "F7", altKey: true }),
    );

    expect(isOn(loaded)).toBe(false);
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

  it("keeps autoSave where storage does work", () => {
    expect(dosOptions(load()).autoSave).toBe(true);
  });

  it("still shows and toggles the filter, it just cannot remember it", () => {
    const loaded = load({ blockStorage: true });
    const crtBtn = loaded.window.document.getElementById(
      "crt-btn",
    ) as HTMLButtonElement;

    expect(crtBtn.textContent).toBe("CRT: ON");

    expect(() => crtBtn.click()).not.toThrow();
    expect(crtBtn.textContent).toBe("CRT: OFF");
  });
});

describe("js-dos-player.js — how the emulator is started", () => {
  it("pins the emulator runtime to the release the page loads", () => {
    const options = dosOptions(load());

    // A loader and an emulator runtime from different builds is not a
    // combination anyone tests; tests/public-assets.test.ts is what keeps
    // this version in step with public/js-dos.html and app.ts.
    expect(options.pathPrefix).toMatch(
      /^https:\/\/cdn\.jsdelivr\.net\/npm\/js-dos@\d+\.\d+\.\d+\/dist\/emulators\/$/,
    );
  });

  it("starts on its own and captures the mouse", () => {
    const options = dosOptions(load());

    expect(options.autoStart).toBe(true);
    expect(options.mouseCapture).toBe(true);
  });
});

beforeEach(() => {
  vi.restoreAllMocks();
});
