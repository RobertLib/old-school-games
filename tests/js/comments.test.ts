import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const scriptContent = readFileSync(
  path.resolve(__dirname, "../../public/js/comments.js"),
  "utf-8",
);

const stylesheet = readFileSync(
  path.resolve(__dirname, "../../public/css/style.css"),
  "utf-8",
);

const PAGE = `<!doctype html><html><head>
  <meta name="csrf-token" content="tok123" />
</head><body>
  <section id="comments-section">
    <div class="comment-load-more" id="comment-load-more-wrap">
      <button id="comment-load-more" data-before="5" data-game-id="7" type="button">
        <span id="comment-load-more-idle">Load earlier comments (<span id="comment-remaining">12</span> more)</span>
        <span hidden id="comment-load-more-busy">Loading…</span>
      </button>
    </div>
    <div id="comment-list">
      <article class="comment" id="comment-1">
        <div class="comment-content">Still the best.</div>
        <button class="comment-reply-btn" data-comment-id="1" data-nick="retrofan" type="button">Reply</button>
        <div class="comment-replies" id="replies-1"></div>
      </article>
    </div>
    <form id="comment-form">
      <input name="gameId" type="hidden" value="7" />
      <input id="comment-parent-id" name="parentId" type="hidden" value="" />
      <p class="comment-reply-context" hidden id="comment-reply-context">
        Replying to <strong id="comment-reply-target"></strong>
        <button class="comment-cancel-reply" id="comment-cancel-reply" type="button">Cancel</button>
      </p>
      <input id="nick" name="nick" type="text" />
      <textarea id="content" name="content"></textarea>
      <button id="comment-submit" type="submit">Post comment</button>
      <p class="alert error" hidden id="comment-error" role="alert"></p>
      <p aria-live="polite" class="visually-hidden" id="comment-status"></p>
    </form>
  </section>
</body></html>`;

let dom: JSDOM;
let doc: Document;
let fetchMock: ReturnType<typeof vi.fn>;
let scrollIntoViewMock: ReturnType<typeof vi.fn<Element["scrollIntoView"]>>;

/**
 * comments.js delegates clicks on `document`, so every test gets its own
 * window — re-running it in a shared document would stack listeners the way
 * a real page never does.
 */
beforeEach(() => {
  dom = new JSDOM(PAGE, { runScripts: "outside-only", url: "http://localhost/" });
  doc = dom.window.document;

  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => '<article class="comment comment-reply">A reply</article>',
  });
  (dom.window as any).fetch = fetchMock;

  // jsdom has no layout engine, so scrolling is stubbed and observed.
  scrollIntoViewMock = vi.fn<Element["scrollIntoView"]>();
  dom.window.Element.prototype.scrollIntoView = scrollIntoViewMock;
  (dom.window as any).matchMedia = () => ({ matches: false });

  dom.window.eval(scriptContent);
});

const byId = (id: string) => doc.getElementById(id) as HTMLElement;
const context = () => byId("comment-reply-context");
const parentInput = () => byId("comment-parent-id") as HTMLInputElement;
const form = () => byId("comment-form") as HTMLFormElement;
const clickReply = () =>
  (doc.querySelector(".comment-reply-btn") as HTMLElement).click();
const submit = () =>
  form().dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
/**
 * Lets everything already queued settle, without waiting on the clock.
 *
 * This used to be `setTimeout(r, 10)`, which is a bet that ten real
 * milliseconds is always enough for a fetch mock and the handlers chained
 * onto it — fine on a quiet laptop, and the first thing to go on a loaded CI
 * runner, where it fails as an assertion about the DOM rather than as a
 * timeout. Draining the microtask queue and then yielding once to the macro
 * queue settles the same work in whatever time it actually takes, and takes
 * none of it when the work is already done.
 */
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
const requestBody = (call = 0) =>
  JSON.parse(fetchMock.mock.calls[call][1].body);

describe("comments.js — reply context banner", () => {
  it("is hidden on a freshly loaded page", () => {
    // Writing a brand new comment must not look like answering someone.
    expect(context().hidden).toBe(true);
    expect(parentInput().value).toBe("");
  });

  it("appears with the nick when Reply is clicked", () => {
    clickReply();

    expect(context().hidden).toBe(false);
    expect(byId("comment-reply-target").textContent).toBe("retrofan");
    expect(parentInput().value).toBe("1");
  });

  it("moves the form into the thread it is answering", () => {
    clickReply();

    expect(form().parentElement!.id).toBe("replies-1");
  });

  it("hides again and clears the parent on Cancel", () => {
    clickReply();
    byId("comment-cancel-reply").click();

    expect(context().hidden).toBe(true);
    expect(parentInput().value).toBe("");
    expect(form().parentElement!.id).not.toBe("replies-1");
  });
});

describe("comments.js — posting", () => {
  it("posts a top-level comment with no parent", async () => {
    (byId("content") as HTMLTextAreaElement).value = "Hi";
    submit();
    await flush();

    expect(requestBody()).toMatchObject({
      content: "Hi",
      gameId: "7",
      parentId: null,
    });
  });

  it("posts a reply with the parent id", async () => {
    clickReply();
    (byId("content") as HTMLTextAreaElement).value = "Yes";
    submit();
    await flush();

    expect(requestBody()).toMatchObject({ parentId: "1" });
  });

  it("appends a reply into the thread, not the top-level list", async () => {
    clickReply();
    (byId("content") as HTMLTextAreaElement).value = "Yes";
    submit();
    await flush();

    expect(byId("replies-1").querySelector(".comment-reply")).not.toBeNull();
  });

  it("resets the banner after a reply is posted", async () => {
    clickReply();
    (byId("content") as HTMLTextAreaElement).value = "Yes";
    submit();
    await flush();

    expect(context().hidden).toBe(true);
    expect(parentInput().value).toBe("");
  });

  it("sends the CSRF token", async () => {
    (byId("content") as HTMLTextAreaElement).value = "Hi";
    submit();
    await flush();

    expect(fetchMock.mock.calls[0][1].headers["X-CSRF-Token"]).toBe("tok123");
  });

  /**
   * form.reset() wiped the nick along with the text, so anybody posting a
   * second comment had to type their name again — which is why threads are
   * full of one named comment followed by a run of "anonymous".
   */
  it("keeps the nick for the next comment and clears only the text", async () => {
    const nick = byId("nick") as HTMLInputElement;
    const content = byId("content") as HTMLTextAreaElement;

    nick.value = "retrofan";
    content.value = "Hi";
    submit();
    await flush();

    expect(nick.value).toBe("retrofan");
    expect(content.value).toBe("");
  });

  it("sends the kept nick with the second comment", async () => {
    const nick = byId("nick") as HTMLInputElement;
    const content = byId("content") as HTMLTextAreaElement;

    nick.value = "retrofan";
    content.value = "Hi";
    submit();
    await flush();

    content.value = "And again";
    submit();
    await flush();

    expect(requestBody(1)).toMatchObject({
      nick: "retrofan",
      content: "And again",
    });
  });

  it("reads fields explicitly rather than through form.<name>", async () => {
    // form.gameId and friends go through the legacy named getter, which is
    // shadowed by real HTMLFormElement properties.
    expect(scriptContent).not.toMatch(/form\.(nick|content|gameId)\b/);
  });
});

describe("comments.js — showing the posted comment", () => {
  async function post(content = "Hi") {
    (byId("content") as HTMLTextAreaElement).value = content;
    submit();
    await flush();
    return doc.querySelector("#comment-list > .comment:last-child") as HTMLElement;
  }

  it("marks the new comment so it stands out in a long thread", async () => {
    const posted = await post();

    expect(posted.classList.contains("comment-new")).toBe(true);
  });

  it("scrolls the new comment into view", async () => {
    const posted = await post();

    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
    expect(scrollIntoViewMock.mock.instances[0]).toBe(posted);
  });

  it("scrolls the minimum amount so an already visible comment stays put", () => {
    // "nearest" is what makes scrollIntoView a no-op when the comment is
    // already on screen.
    expect(scriptContent).toMatch(/block:\s*"nearest"/);
  });

  it("uses scrollIntoView, not window.scrollTo", () => {
    // The comment list is its own scrollbox (max-height + overflow: auto),
    // so moving the window alone would never reach the comment.
    expect(scriptContent).toMatch(/\.scrollIntoView\(/);
    expect(scriptContent).not.toMatch(/window\.scrollTo\s*\(/);
  });

  it("animates the scroll by default", async () => {
    await post();

    expect(scrollIntoViewMock.mock.calls[0][0]).toMatchObject({
      behavior: "smooth",
    });
  });

  it("jumps without animation when reduced motion is requested", async () => {
    (dom.window as any).matchMedia = () => ({ matches: true });

    await post();

    expect(scrollIntoViewMock.mock.calls[0][0]).toMatchObject({
      behavior: "auto",
    });
  });

  it("announces the post for screen readers", async () => {
    await post();

    expect(byId("comment-status").textContent).toBe("Comment posted.");
  });

  // A rejected comment used to come back as a redirect the fetch followed,
  // so the whole game page landed in the thread as a "comment".
  it("shows the server's reason and posts nothing when rejected", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Content is too long" }),
    });

    await post();

    expect(byId("comment-error").textContent).toBe("Content is too long");
    expect(byId("comment-error").hasAttribute("hidden")).toBe(false);
    expect(doc.querySelectorAll("#comment-list > .comment")).toHaveLength(1);
  });

  it("falls back to a generic message when the body carries no reason", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => {
        throw new Error("not json");
      },
    });

    await post();

    expect(byId("comment-error").textContent).toContain("Could not post");
  });

  it("clears a previous error once a comment goes through", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Content is required" }),
    });
    await post();

    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => '<article class="comment">Fine now</article>',
    });
    await post();

    expect(byId("comment-error").hasAttribute("hidden")).toBe(true);
    expect(byId("comment-error").textContent).toBe("");
  });

  it("highlights and scrolls to a reply, not the last top-level comment", async () => {
    clickReply();
    (byId("content") as HTMLTextAreaElement).value = "Yes";
    submit();
    await flush();

    const reply = byId("replies-1").querySelector(".comment-reply")!;
    expect(reply.classList.contains("comment-new")).toBe(true);
    expect(scrollIntoViewMock.mock.instances[0]).toBe(reply);
    expect(
      doc.querySelector("#comment-list > .comment")!.classList.contains("comment-new"),
    ).toBe(false);
  });
});

describe("comments.js — loading earlier comments", () => {
  function mockBatch(payload: Record<string, unknown>) {
    fetchMock.mockResolvedValue({ ok: true, json: async () => payload });
  }

  const clickLoadMore = async () => {
    byId("comment-load-more").click();
    await flush();
  };

  it("asks for the batch older than the current cursor", async () => {
    mockBatch({ html: "", oldestId: null, remaining: 0 });

    await clickLoadMore();

    expect(fetchMock).toHaveBeenCalledWith("/comments/7?before=5");
  });

  it("prepends the batch so older comments land above the newer ones", async () => {
    mockBatch({
      html: '<article class="comment" id="comment-4">older</article>',
      oldestId: 4,
      remaining: 8,
    });

    await clickLoadMore();

    const first = doc.querySelector("#comment-list > .comment")!;
    expect(first.id).toBe("comment-4");
  });

  it("moves the cursor back for the next batch", async () => {
    mockBatch({ html: "<article class='comment'>x</article>", oldestId: 4, remaining: 8 });

    await clickLoadMore();

    expect(byId("comment-load-more").dataset.before).toBe("4");
  });

  it("keeps the remaining counter up to date", async () => {
    mockBatch({ html: "<article class='comment'>x</article>", oldestId: 4, remaining: 8 });

    await clickLoadMore();

    expect(byId("comment-remaining").textContent).toBe("8");
  });

  it("hides the button once nothing older is left", async () => {
    mockBatch({ html: "<article class='comment'>x</article>", oldestId: 1, remaining: 0 });

    await clickLoadMore();

    expect(byId("comment-load-more-wrap").hidden).toBe(true);
  });

  it("swaps the label while loading without destroying the counter", async () => {
    // Rewriting the button's text would throw away the element holding the
    // live count.
    let resolve: (v: unknown) => void = () => {};
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));

    byId("comment-load-more").click();

    expect(byId("comment-load-more-idle").hidden).toBe(true);
    expect(byId("comment-load-more-busy").hidden).toBe(false);
    expect(doc.getElementById("comment-remaining")).not.toBeNull();

    resolve({ ok: true, json: async () => ({ html: "", oldestId: null, remaining: 3 }) });
    await flush();

    expect(byId("comment-load-more-idle").hidden).toBe(false);
    expect(byId("comment-load-more-busy").hidden).toBe(true);
    expect(byId("comment-remaining").textContent).toBe("3");
  });

  it("does not fire twice while a batch is in flight", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    byId("comment-load-more").click();
    byId("comment-load-more").click();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never scrolls the page — the button and everything above it stay put", async () => {
    mockBatch({ html: "<article class='comment'>x</article>", oldestId: 4, remaining: 8 });

    await clickLoadMore();

    // Only posting a comment scrolls; loading earlier ones must not.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("announces progress for screen readers", async () => {
    mockBatch({ html: "<article class='comment'>x</article>", oldestId: 4, remaining: 8 });

    await clickLoadMore();

    expect(byId("comment-status").textContent).toContain("8 still older");
  });
});

describe("style.css — scrolled-to comment", () => {
  it("gives comments a scroll margin so they land clear of the edges", () => {
    expect(stylesheet).toMatch(/\.comment\s*\{[^}]*scroll-margin/);
  });
});

describe("style.css — hidden attribute", () => {
  it("keeps [hidden] winning over author display rules", () => {
    // .comment-reply-context sets `display: flex`, which beats the browser's
    // own [hidden] rule and left the reply banner permanently on screen.
    expect(stylesheet).toMatch(
      /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/,
    );
  });
});
