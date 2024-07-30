import { beforeEach, describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JSDOM } from "jsdom";
import ejs from "ejs";

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
    <h2>Comments <span class="comment-count">(12)</span></h2>
    <div class="comment-load-more" id="comment-load-more-wrap">
      <button id="comment-load-more" data-before="5" data-game-id="7" type="button">
        <span id="comment-load-more-idle">Load earlier comments (<span id="comment-remaining">12</span> more)</span>
        <span hidden id="comment-load-more-busy">Loading…</span>
      </button>
      <p class="alert error" hidden id="comment-load-more-error" role="alert"></p>
    </div>
    <div class="comment-load-more" id="comment-link-error-wrap" hidden>
      <p class="alert error" id="comment-link-error" role="alert"></p>
      <button id="comment-link-retry" type="button">Try again</button>
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
 *
 * The address and the fetch are parameters because the script now reads
 * location.hash the moment it runs, and may start fetching straight away
 * (see "following a link to an older comment" below) — so whatever the fetch
 * is going to answer has to be in place before the script is, not after.
 */
function openPage(
  url = "http://localhost/",
  fetchImpl?: ReturnType<typeof vi.fn>,
  page = PAGE,
) {
  dom = new JSDOM(page, { runScripts: "outside-only", url });
  doc = dom.window.document;

  fetchMock =
    fetchImpl ??
    vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        '<article class="comment comment-reply">A reply</article>',
    });
  (dom.window as any).fetch = fetchMock;

  // jsdom has no layout engine, so scrolling is stubbed and observed.
  scrollIntoViewMock = vi.fn<Element["scrollIntoView"]>();
  dom.window.Element.prototype.scrollIntoView = scrollIntoViewMock;
  (dom.window as any).matchMedia = () => ({ matches: false });

  dom.window.eval(scriptContent);
}

beforeEach(() => {
  openPage();
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

  /**
   * The load-more path below has asked public/js/ui.js to rewrite a batch's
   * dates since the day it was found showing two formats in one list; the
   * post path never did, so the comment a visitor had just written was the
   * one line in the thread still reading "January 5, 2026" among "Jan 5,
   * 2026"s. Scoped to that comment, which is all that is new.
   */
  it("re-formats the date in the comment it just posted", async () => {
    const initLocalDates = vi.fn();

    (dom.window as any).initLocalDates = initLocalDates;
    fetchMock.mockResolvedValue({
      ok: true,
      text: async () =>
        '<article class="comment" id="comment-9"><time data-date="2026-01-05T00:00:00.000Z">January 5, 2026</time></article>',
    });

    await post();

    expect(initLocalDates).toHaveBeenCalledTimes(1);
    expect(initLocalDates).toHaveBeenCalledWith(byId("comment-9"));
  });

  // Optional, as on the load-more path: ui.js is a separate file, and this
  // one must not fail to post because it was blocked.
  it("still posts when ui.js has not provided the date rewrite", async () => {
    delete (dom.window as any).initLocalDates;

    await post();

    expect(byId("comment-error").hasAttribute("hidden")).toBe(true);
    expect(byId("comment-status").textContent).toBe("Comment posted.");
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

/**
 * Where keyboard focus is once a comment has gone through.
 *
 * resetReply put the form back with insertBefore after every successful post,
 * whether or not it had moved — and inserting a node where it already is
 * still takes it out of the document first, which blurs anything focused
 * inside it (Chrome and WebKit do it, and so does jsdom). So every post
 * dropped the visitor to <body> and the next Tab started from the navbar.
 */
describe("comments.js — focus after posting", () => {
  const content = () => byId("content") as HTMLTextAreaElement;

  it("does not take the form out of the page when it never moved", async () => {
    const moves: Node[] = [];
    const observer = new dom.window.MutationObserver((records) => {
      records.forEach((record) =>
        moves.push(...record.removedNodes, ...record.addedNodes),
      );
    });

    observer.observe(form().parentNode!, { childList: true });

    content().value = "Hi";
    submit();
    await flush();
    observer.disconnect();

    expect(moves).not.toContain(form());
  });

  it("puts focus on the comment it just posted", async () => {
    byId("comment-submit").focus();
    content().value = "Hi";
    submit();
    await flush();

    const posted = doc.querySelector(
      "#comment-list > .comment:last-child",
    ) as HTMLElement;

    expect(doc.activeElement).toBe(posted);
    // Focusable by script without becoming a tab stop of its own.
    expect(posted.getAttribute("tabindex")).toBe("-1");
  });

  // A reply is where the form really does move — from the thread back to the
  // foot of the page — and so where focus was certain to be lost.
  it("puts focus on a reply once the form has gone back to the foot of the page", async () => {
    clickReply();
    content().value = "Yes";
    byId("comment-submit").focus();
    submit();
    await flush();

    const reply = byId("replies-1").querySelector(".comment-reply");

    expect(form().parentElement!.id).not.toBe("replies-1");
    expect(doc.activeElement).toBe(reply);
  });

  // scrollIntoView has already brought it into view with the navbar allowed
  // for; focus()'s own scroll would jump the page instantly on top of that.
  it("moves focus without scrolling a second time", async () => {
    const focus = vi.spyOn(dom.window.HTMLElement.prototype, "focus");

    submit();
    await flush();

    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(scrollIntoViewMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the textarea when there is no comment to land on", async () => {
    clickReply();
    // The thread the reply was for is no longer where the script looks.
    byId("replies-1").id = "replies-gone";
    submit();
    await flush();

    expect(doc.activeElement).toBe(content());
  });

  it("leaves focus alone when the post is refused", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Content is too long" }),
    });
    content().focus();
    submit();
    await flush();

    expect(doc.activeElement).toBe(content());
  });

  // Somebody who has moved on to the nick field while the post was in flight
  // is not pulled out of it mid-word — the same courtesy the walk to a linked
  // comment below extends to a reader who started on something else.
  it("does not take focus from a field the visitor moved to meanwhile", async () => {
    let answer!: () => void;

    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = () =>
          resolve({
            ok: true,
            text: async () => '<article class="comment">Hi</article>',
          });
      }),
    );

    byId("comment-submit").focus();
    content().value = "Hi";
    submit();

    const nick = byId("nick") as HTMLInputElement;

    nick.focus();
    answer();
    await flush();

    expect(doc.activeElement).toBe(nick);
  });
});

/**
 * Whatever the visitor does while a comment is on its way.
 *
 * The textarea stayed editable for the whole request, and the success handler
 * then cleared it and reset the reply state regardless of what had happened
 * since. Text typed after pressing Post was wiped when the answer arrived —
 * the reviewer's follow-up thought came back as "" — and a Reply clicked in
 * the meantime was undone: the form carried back to the foot of the page, the
 * comment it had been opened on forgotten.
 */
describe("comments.js — while a comment is posting", () => {
  const content = () => byId("content") as HTMLTextAreaElement;

  /** A post that is not answered until the test says so. */
  function heldPost() {
    let settleWith!: (response: unknown) => void;

    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        settleWith = resolve;
      }),
    );

    return {
      posted: (html: string) =>
        settleWith({ ok: true, text: async () => html }),
      refused: (error: string) =>
        settleWith({ ok: false, json: async () => ({ error }) }),
    };
  }

  it("keeps the text read-only until the answer is in", async () => {
    const post = heldPost();

    content().value = "First";
    submit();

    expect(content().readOnly).toBe(true);

    post.posted('<article class="comment">First</article>');
    await flush();

    expect(content().readOnly).toBe(false);
    expect(content().value).toBe("");
  });

  it("gives the text back, editable, when the post is refused", async () => {
    const post = heldPost();

    content().value = "Too long";
    submit();
    post.refused("Content is too long");
    await flush();

    expect(content().readOnly).toBe(false);
    expect(content().value).toBe("Too long");
  });

  // readOnly stops typing. This is anything that gets past it — a paste
  // helper, autofill, another script — and it is not the visitor's to lose.
  it("keeps text that changed while the post was in flight", async () => {
    const post = heldPost();

    content().value = "First";
    submit();

    content().value = "And a second thought";

    post.posted('<article class="comment">First</article>');
    await flush();

    expect(content().value).toBe("And a second thought");
  });

  it("leaves a reply opened meanwhile where the visitor opened it", async () => {
    const post = heldPost();

    content().value = "A new thread";
    submit();

    clickReply();

    post.posted('<article class="comment" id="comment-9">A new thread</article>');
    await flush();

    expect(form().parentElement!.id).toBe("replies-1");
    expect(parentInput().value).toBe("1");
    expect(context().hidden).toBe(false);
    expect(byId("comment-reply-target").textContent).toBe("retrofan");
    // What was sent still lands where it was sent to...
    expect(doc.querySelector("#comment-list > #comment-9")).not.toBeNull();
    // ...and its text is cleared, so the reply does not start as a copy of it.
    expect(content().value).toBe("");
    // The visitor is writing the reply: not scrolled away from it, and not
    // pulled out of the textarea onto the comment that just arrived.
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(content());
    // Still announced, and still marked, for when they get there.
    expect(byId("comment-status").textContent).toBe("Comment posted.");
    expect(byId("comment-9").classList.contains("comment-new")).toBe(true);
  });

  it("sends a reply opened meanwhile to the thread it was opened on", async () => {
    const post = heldPost();

    content().value = "A new thread";
    submit();
    clickReply();
    post.posted('<article class="comment" id="comment-9">A new thread</article>');
    await flush();

    fetchMock.mockResolvedValue({
      ok: true,
      text: async () => '<article class="comment comment-reply">Yes</article>',
    });
    content().value = "Yes";
    submit();
    await flush();

    expect(requestBody(1)).toMatchObject({ parentId: "1", content: "Yes" });
    expect(byId("replies-1").querySelector(".comment-reply")).not.toBeNull();
  });
});

/**
 * The heading beside "Comments" counts every comment on the game, replies
 * included: routes/home.ts renders Comment.countAll into it (see
 * views/games/game-detail.ejs). It is rendered once, so posting a comment
 * left it a comment behind until the next page load — the thread said one
 * thing and the heading above it another.
 */
describe("comments.js — the count in the heading", () => {
  const count = () => doc.querySelector(".comment-count")!.textContent;

  it("goes up by one when a root comment is posted", async () => {
    submit();
    await flush();

    expect(count()).toBe("(13)");
  });

  // A reply is one more comment on the game, and the number counts all of
  // them. It used to be skipped, on the belief that the heading counted
  // root comments only — so it fell one behind for every reply.
  it("goes up by one when a reply is posted", async () => {
    clickReply();
    submit();
    await flush();

    expect(count()).toBe("(13)");
  });

  it("counts a reply and a new thread alike, one each", async () => {
    submit();
    await flush();

    clickReply();
    submit();
    await flush();

    expect(count()).toBe("(14)");
  });

  // The number is read back out of the heading rather than counted from the
  // DOM: the list is paginated, so what is on the page is not the total.
  it("does not count the comments that happen to be on the page", async () => {
    doc.querySelector(".comment-count")!.textContent = "(400)";

    submit();
    await flush();

    expect(count()).toBe("(401)");
  });

  it("does not break a page whose heading has no count", async () => {
    doc.querySelector(".comment-count")!.remove();

    submit();
    await flush();

    expect(doc.querySelector("#comment-error")!.hasAttribute("hidden")).toBe(
      true,
    );
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
    // The visible root must be newer than the cursor, as on a real page.
    byId("comment-1").id = "comment-5";
    mockBatch({
      html: '<article class="comment" id="comment-4">older</article>',
      oldestId: 4,
      remaining: 8,
    });

    await clickLoadMore();

    const first = doc.querySelector("#comment-list > .comment")!;
    expect(first.id).toBe("comment-4");
  });

  /**
   * public/js/ui.js rewrites the server's US-formatted dates into the
   * reader's own locale, once, on DOMContentLoaded — which is long before a
   * fetched batch exists. So a thread that had been extended showed
   * "January 5, 2026" above "Jan 5, 2026" in one list until this call was
   * added. It is optional (`?.`): ui.js is a separate file and this one must
   * not die if it is blocked.
   */
  it("re-formats the dates in the batch it just inserted", async () => {
    const initLocalDates = vi.fn();

    (dom.window as any).initLocalDates = initLocalDates;

    mockBatch({
      html: '<article class="comment" id="comment-4"><time data-date="2026-01-05T00:00:00.000Z">January 5, 2026</time></article>',
      oldestId: 4,
      remaining: 8,
    });

    await clickLoadMore();

    expect(initLocalDates).toHaveBeenCalledWith(byId("comment-list"));
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

/**
 * Where keyboard focus goes through "Load earlier comments".
 *
 * The button is where focus is when it is pressed, and it was taken away
 * twice: `disabled` for the length of the request — a browser drops focus
 * from a control the moment it is disabled — and, after the last batch, its
 * wrapper hidden with it still inside. Either way a keyboard visitor was
 * returned to <body>, the loss the submit path in the same file already
 * documents and handles. jsdom does neither, so these check the state the
 * browser acts on rather than where focus ends up after it.
 */
describe("comments.js — focus through 'Load earlier comments'", () => {
  const button = () => byId("comment-load-more") as HTMLButtonElement;

  it("marks the button busy without disabling it", async () => {
    let answer!: (payload: Record<string, unknown>) => void;

    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        answer = (payload) => resolve({ ok: true, json: async () => payload });
      }),
    );

    button().focus();
    button().click();

    expect(button().disabled).toBe(false);
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(doc.activeElement).toBe(button());

    answer({ html: "", oldestId: 4, remaining: 3 });
    await flush();

    expect(button().hasAttribute("aria-disabled")).toBe(false);
  });

  it("still asks only once while it is busy", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));

    button().click();
    button().click();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("moves focus to the first comment it brought in when the button goes", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        html: '<article class="comment" id="comment-3">oldest</article><article class="comment" id="comment-4">older</article>',
        oldestId: 3,
        remaining: 0,
      }),
    });

    button().focus();
    button().click();
    await flush();

    expect(byId("comment-load-more-wrap").hidden).toBe(true);
    expect(doc.activeElement).toBe(byId("comment-3"));
    // Focusable by script without becoming a tab stop of its own.
    expect(byId("comment-3").getAttribute("tabindex")).toBe("-1");
  });

  // Only the button's own focus is looked after: a visitor who is somewhere
  // else — typing, say — is not moved.
  it("leaves focus alone when the button did not have it", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        html: '<article class="comment" id="comment-3">oldest</article>',
        oldestId: 3,
        remaining: 0,
      }),
    });

    const content = byId("content") as HTMLTextAreaElement;

    content.focus();
    button().click();
    await flush();

    expect(doc.activeElement).toBe(content);
  });

  it("draws the busy button the way a disabled one is drawn", () => {
    expect(stylesheet).toMatch(
      /\.btn:disabled,\s*\.btn\[aria-disabled="true"\]\s*\{[^}]*cursor:\s*not-allowed/,
    );
  });
});

/**
 * Where a failure is shown, in whose words, and how many times.
 *
 * A request that never reached the server rejects with the browser's own
 * TypeError, and its message was put on the page as it came: "Failed to
 * fetch" in Chrome, "Load failed" in Safari. And a batch that failed to load
 * showed its reason in the post form's error box — at the foot of the page,
 * nowhere near the button that was pressed — through showError, which also
 * wrote it into the polite status region, so it was announced twice: once by
 * role="alert" and again by the live region.
 */
describe("comments.js — failures, in words and in place", () => {
  const loadError = () => byId("comment-load-more-error");
  const clickLoadMore = async () => {
    byId("comment-load-more").click();
    await flush();
  };

  it.each(["Failed to fetch", "Load failed", "NetworkError when attempting to fetch resource."])(
    "says a post failed in its own words when the browser says %j",
    async (browserText) => {
      fetchMock.mockRejectedValue(new dom.window.TypeError(browserText));

      submit();
      await flush();

      expect(byId("comment-error").textContent).toBe(
        "Could not post the comment. Please try again.",
      );
    },
  );

  it("says a batch failed in its own words when the network does", async () => {
    fetchMock.mockRejectedValue(new dom.window.TypeError("Failed to fetch"));

    await clickLoadMore();

    expect(loadError().textContent).toBe(
      "Could not load earlier comments. Please try again.",
    );
  });

  // A 200 whose body is not JSON — a proxy's error page, say — throws a
  // SyntaxError out of response.json(), and its message is no better.
  it("does not show the parser's complaint about an unreadable batch", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => {
        throw new dom.window.SyntaxError("Unexpected token '<'");
      },
    });

    await clickLoadMore();

    expect(loadError().textContent).toBe(
      "Could not load earlier comments. Please try again.",
    );
  });

  it("still shows the server's own reason", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Too many requests, please try again later." }),
    });

    await clickLoadMore();

    expect(loadError().textContent).toBe(
      "Too many requests, please try again later.",
    );
  });

  it("shows a batch's failure beside the button, not under the form", async () => {
    fetchMock.mockRejectedValue(new dom.window.TypeError("Failed to fetch"));

    await clickLoadMore();

    expect(loadError().hidden).toBe(false);
    expect(byId("comment-load-more-wrap").contains(loadError())).toBe(true);
    expect(byId("comment-error").hidden).toBe(true);
    expect(byId("comment-error").textContent).toBe("");
  });

  it("announces a batch's failure once", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Too many requests, please try again later." }),
    });

    await clickLoadMore();

    expect(loadError().getAttribute("role")).toBe("alert");
    expect(loadError().textContent).toContain("Too many requests");
    expect(byId("comment-status").textContent).not.toContain("Too many requests");
  });

  it("announces a post's failure once", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Content is too long" }),
    });

    submit();
    await flush();

    expect(byId("comment-error").textContent).toBe("Content is too long");
    expect(byId("comment-status").textContent).not.toContain("Content is too long");
  });

  /**
   * One announcement has to be a reliable one. An alert is announced when
   * what it says changes while it is on the page; text written into it while
   * it is still hidden is not in the accessibility tree to change, and
   * revealing it afterwards is announced by some screen readers and not by
   * others. Shown first, then written.
   */
  it.each([
    ["comment-error", () => fetchMock.mockRejectedValue(new dom.window.TypeError("x")), () => submit()],
    [
      "comment-load-more-error",
      () => fetchMock.mockRejectedValue(new dom.window.TypeError("x")),
      () => byId("comment-load-more").click(),
    ],
  ])("reveals #%s before writing into it", async (id, fail, act) => {
    const region = byId(id);
    const text = Object.getOwnPropertyDescriptor(
      dom.window.Node.prototype,
      "textContent",
    )!;
    // Whether the region was hidden at the moment each message went in.
    const hiddenWhenWritten: boolean[] = [];

    Object.defineProperty(region, "textContent", {
      configurable: true,
      get() {
        return text.get!.call(region);
      },
      set(value: string) {
        if (value) hiddenWhenWritten.push(region.hasAttribute("hidden"));
        text.set!.call(region, value);
      },
    });

    fail();
    act();
    await flush();

    expect(hiddenWhenWritten).toEqual([false]);
  });

  it("clears a batch's failure once a batch arrives", async () => {
    fetchMock.mockRejectedValueOnce(new dom.window.TypeError("Failed to fetch"));
    await clickLoadMore();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ html: "", oldestId: 4, remaining: 3 }),
    });
    await clickLoadMore();

    expect(loadError().hidden).toBe(true);
    expect(loadError().textContent).toBe("");
  });

  // The form's error is about the comment the visitor is writing, and is
  // still true after they have read further back in the thread.
  it("leaves the form's own error alone when earlier comments load", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Content is too long" }),
    });
    submit();
    await flush();

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ html: "", oldestId: 4, remaining: 3 }),
    });
    await clickLoadMore();

    expect(byId("comment-error").hidden).toBe(false);
    expect(byId("comment-error").textContent).toBe("Content is too long");
  });

  // A page rendered before the view carried the box beside the button still
  // gets told — in the form's box, as it always was.
  it("falls back to the form's box on markup without one of its own", async () => {
    openPage(
      "http://localhost/",
      vi.fn().mockRejectedValue(new dom.window.TypeError("Failed to fetch")),
      PAGE.replace(
        '<p class="alert error" hidden id="comment-load-more-error" role="alert"></p>',
        "",
      ),
    );

    await clickLoadMore();

    expect(byId("comment-error").textContent).toBe(
      "Could not load earlier comments. Please try again.",
    );
  });

  it("ships the box beside the button in the view", async () => {
    const VIEWS = path.resolve(__dirname, "../../views");
    const html = await ejs.renderFile(
      path.join(VIEWS, "comments/comment-list.ejs"),
      { comments: [], game: { id: 7 }, remainingComments: 3 },
      { root: VIEWS, views: [VIEWS] },
    );
    const view = new JSDOM(html).window.document;
    const box = view.getElementById("comment-load-more-error");

    expect(box).not.toBeNull();
    expect(view.getElementById("comment-load-more-wrap")!.contains(box)).toBe(true);
    expect(box!.getAttribute("role")).toBe("alert");
    expect(box!.hasAttribute("hidden")).toBe(true);
  });
});

/** Direct links must reach replies beyond the initial cap in one request. */
describe("comments.js — following a link to an older comment", () => {
  const thread = (id: number) => ({
    html: `<article class="comment" id="comment-${id}">older<div class="comment-replies" id="replies-${id}"></div></article>`,
    rootId: id,
  });
  const answered = (payload: Record<string, unknown>) =>
    vi.fn().mockResolvedValue({ ok: true, json: async () => payload });
  function heldResponse() {
    let answer!: (payload: Record<string, unknown>) => void;
    const response = new Promise((resolve) => {
      answer = (payload) => resolve({ ok: true, json: async () => payload });
    });
    return { response, answer };
  }

  it("fetches the linked thread directly and brings the target into view", async () => {
    openPage("http://localhost/#comment-3", answered(thread(3)));
    await flush();

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/comments/7/thread/3"]);
    const linked = byId("comment-3");
    expect(doc.activeElement).toBe(linked);
    expect(linked.getAttribute("tabindex")).toBe("-1");
    expect(linked.classList.contains("comment-linked")).toBe(true);
    expect(scrollIntoViewMock.mock.instances[0]).toBe(linked);
    expect(scrollIntoViewMock.mock.calls[0][0]).toMatchObject({ block: "start" });
    expect(stylesheet).toMatch(/\.comment:target,\s*\.comment\.comment-linked\s*\{[^}]*outline:/);
    // Loading a distant root does not skip intermediate root pages.
    expect(byId("comment-load-more").dataset.before).toBe("5");
  });

  it("merges an old reply into an existing root without replacing its draft", async () => {
    const held = heldResponse();
    openPage("http://localhost/#comment-40", vi.fn().mockReturnValue(held.response));
    clickReply();
    const content = byId("content") as HTMLTextAreaElement;
    content.value = "unfinished reply";
    held.answer({
      html: '<article class="comment" id="comment-1"><div class="comment-replies" id="replies-1"><article class="comment comment-reply" id="comment-40">old reply</article></div></article>',
      rootId: 1,
    });
    await flush();

    expect(doc.querySelectorAll("#comment-1")).toHaveLength(1);
    expect(byId("replies-1").contains(byId("comment-40"))).toBe(true);
    expect(form().parentElement).toBe(byId("replies-1"));
    expect(content.value).toBe("unfinished reply");
    expect(doc.activeElement).toBe(content);
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(byId("comment-40").classList.contains("comment-linked")).toBe(true);
  });

  it("adds reply paging when an open thread grows beyond its initial window", async () => {
    const held = heldResponse();
    openPage("http://localhost/#comment-71", vi.fn().mockReturnValue(held.response));
    byId("replies-1").insertAdjacentHTML("beforeend", replyHtml(2));
    clickReply();
    const content = byId("content") as HTMLTextAreaElement;
    content.value = "unfinished reply";

    // Use the real partial: the paging control is a sibling of the replies,
    // and merging only .comment nodes used to discard it.
    const comment = (id: number) => ({
      id, gameId: 7, nick: "retrofan", content: `reply ${id}`,
      createdAt: "2026-01-05T00:00:00.000Z", replies: [], hiddenReplies: 0,
    });
    const html = await ejs.renderFile(
      path.resolve(__dirname, "../../views/comments/comment-item.ejs"),
      {
        comment: {
          ...comment(1),
          replies: Array.from({ length: 50 }, (_, index) => comment(index + 22)),
          hiddenReplies: 20,
          replyCursor: 22,
        },
        isReply: false,
      },
    );
    held.answer({ html, rootId: 1 });
    await flush();

    const paging = doc.querySelector<HTMLButtonElement>(".comment-replies-load")!;
    expect(paging).not.toBeNull();
    expect(paging.dataset.before).toBe("22");
    expect(byId("replies-1").firstElementChild).toBe(paging.closest(".comment-replies-more"));
    expect(form().parentElement).toBe(byId("replies-1"));
    expect(content.value).toBe("unfinished reply");
    expect(doc.activeElement).toBe(content);

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      html: Array.from({ length: 20 }, (_, index) => replyHtml(index + 2)).join(""),
      oldestId: 2, remaining: 0,
    }) });
    paging.click();
    await flush();

    expect(fetchMock).toHaveBeenLastCalledWith("/comments/7/replies/1?before=22");
    expect(doc.querySelectorAll("#replies-1 > .comment")).toHaveLength(70);
    expect(doc.querySelectorAll("#comment-2")).toHaveLength(1);
    expect(paging.closest<HTMLElement>(".comment-replies-more")!.hidden).toBe(true);
    expect(content.value).toBe("unfinished reply");
    expect(doc.activeElement).toBe(content);
  });

  it.each([false, true])("keeps the live reply cursor and control when hidden=%s", async (hidden) => {
    const held = heldResponse();
    openPage("http://localhost/#comment-100", vi.fn().mockReturnValue(held.response));
    byId("replies-1").innerHTML = replyPaging +
      Array.from({ length: 50 }, (_, index) => replyHtml(index + 60)).join("");
    const wrap = doc.querySelector<HTMLElement>(".comment-replies-more")!;
    const paging = doc.querySelector<HTMLButtonElement>(".comment-replies-load")!;
    wrap.hidden = hidden;
    if (!hidden) paging.focus();

    held.answer({
      html: `<article class="comment" id="comment-1"><div class="comment-replies" id="replies-1">${replyPaging.replace('data-before="60"', 'data-before="80"')}${Array.from({ length: 50 }, (_, index) => replyHtml(index + 80)).join("")}</div></article>`,
      rootId: 1,
    });
    await flush();

    expect(doc.querySelectorAll(".comment-replies-more")).toHaveLength(1);
    expect(doc.querySelector(".comment-replies-load")).toBe(paging);
    expect(paging.dataset.before).toBe("60");
    expect(wrap.hidden).toBe(hidden);
    if (!hidden) expect(doc.activeElement).toBe(paging);
  });

  it.each([false, true])("loads a gap between snapshots without restarting the old pager (hidden=%s)", async (hidden) => {
    const held = heldResponse();
    openPage("http://localhost/#comment-161", vi.fn().mockReturnValue(held.response));
    byId("replies-1").innerHTML = replyPaging.replace('data-before="60"', 'data-before="12"') +
      Array.from({ length: 50 }, (_, index) => replyHtml(index + 12)).join("");
    byId("replies-1").dataset.newestReply = "61";
    const original = doc.querySelector<HTMLButtonElement>(".comment-replies-load")!;
    original.closest<HTMLElement>(".comment-replies-more")!.hidden = hidden;
    clickReply();
    (byId("content") as HTMLTextAreaElement).value = "draft";

    held.answer({
      html: `<article class="comment" id="comment-1"><div class="comment-replies" id="replies-1" data-newest-reply="161">${replyPaging.replace('data-before="60"', 'data-before="112"')}${Array.from({ length: 50 }, (_, index) => replyHtml(index + 112)).join("")}</div></article>`,
      rootId: 1,
    });
    await flush();
    const gap = doc.querySelector<HTMLButtonElement>('.comment-replies-load[data-after="61"]')!;
    expect(gap).not.toBeNull();
    expect(original.dataset.before).toBe("12");
    expect(original.closest<HTMLElement>(".comment-replies-more")!.hidden).toBe(hidden);
    expect(byId("content")).toBe(doc.activeElement);

    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      html: Array.from({ length: 50 }, (_, index) => replyHtml(index + 62)).join(""),
      oldestId: 62, remaining: 0,
    }) });
    gap.click();
    await flush();
    expect(fetchMock).toHaveBeenLastCalledWith("/comments/7/replies/1?before=112&after=61");
    expect(doc.querySelectorAll("#replies-1 > .comment")).toHaveLength(150);
    expect(gap.closest<HTMLElement>(".comment-replies-more")!.hidden).toBe(true);
    expect(original.dataset.before).toBe("12");
    expect((byId("content") as HTMLTextAreaElement).value).toBe("draft");
  });

  it.each(["", "#comments", "#comment-1"])("fetches nothing for a visible target or unrelated fragment %s", async (hash) => {
    openPage(`http://localhost/${hash}`);
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("loads an old reply even when there are no older root batches", async () => {
    openPage("http://localhost/#comment-2", answered(thread(2)), PAGE.replace(
      'id="comment-load-more-wrap"', 'id="comment-load-more-wrap" hidden',
    ));
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/comments/7/thread/2");
    expect(doc.activeElement).toBe(byId("comment-2"));
  });

  it("reports a missing comment without fetching unrelated pages", async () => {
    openPage("http://localhost/#comment-2", vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: "Comment not found" }),
    }));
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(byId("comment-link-error-wrap").hidden).toBe(false);
    expect(byId("comment-link-error").textContent).toBe("Comment not found");
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
    expect(doc.activeElement).toBe(doc.body);
  });

  it("offers an independent retry after a failed request", async () => {
    const mock = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, json: async () => thread(2) });
    openPage("http://localhost/#comment-2", mock);
    await flush();
    expect(byId("comment-link-error").textContent).toBe("Could not load the linked comment. Please try again.");
    byId("comment-error").hidden = false;
    byId("comment-error").textContent = "Posting failed";
    byId("comment-link-retry").focus();
    byId("comment-link-retry").click();
    byId("comment-link-retry").click();
    expect(byId("comment-link-error-wrap").hidden).toBe(false);
    expect(byId("comment-link-retry").getAttribute("aria-disabled")).toBe("true");
    await flush();
    expect(mock).toHaveBeenCalledTimes(2);
    expect(byId("comment-link-error-wrap").hidden).toBe(true);
    expect(byId("comment-error").textContent).toBe("Posting failed");
    expect(byId("comment-2")).not.toBeNull();
    expect(doc.activeElement).toBe(byId("comment-2"));
  });

  it("shows a rate limit refusal in the link error box", async () => {
    openPage("http://localhost/#comment-2", vi.fn().mockResolvedValue({
      ok: false, json: async () => ({ error: "Too many requests, please try again later." }),
    }));
    await flush();
    expect(byId("comment-link-error").textContent).toContain("Too many requests");
    expect(byId("comment-load-more-error").hidden).toBe(true);
  });

  it("does not insert or focus a superseded target", async () => {
    const held = heldResponse();
    openPage("http://localhost/#comment-4", vi.fn().mockReturnValue(held.response));
    dom.window.location.hash = "#comment-1";
    await flush();
    held.answer(thread(4));
    await flush();
    expect(byId("comment-4")).toBeNull();
    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it("does not report a superseded request's failure", async () => {
    let reject!: (reason: unknown) => void;
    openPage("http://localhost/#comment-4", vi.fn().mockReturnValue(new Promise((_resolve, fail) => { reject = fail; })));
    dom.window.location.hash = "#comments";
    await flush();
    reject(new TypeError("Failed to fetch"));
    await flush();
    expect(byId("comment-link-error-wrap").hidden).toBe(true);
    expect(byId("comment-link-retry").hasAttribute("aria-disabled")).toBe(false);
  });

  it("handles a direct link independently of an in-flight root page", async () => {
    const held = heldResponse();
    const mock = vi.fn().mockReturnValueOnce(held.response)
      .mockResolvedValueOnce({ ok: true, json: async () => thread(3) });
    openPage("http://localhost/", mock);
    byId("comment-load-more").click();
    dom.window.location.hash = "#comment-3";
    await flush();
    expect(mock.mock.calls.map(([url]) => url)).toEqual(["/comments/7?before=5", "/comments/7/thread/3"]);
    held.answer({ html: thread(3).html + thread(4).html, oldestId: 3, remaining: 2 });
    await flush();
    expect(doc.querySelectorAll("#comment-3")).toHaveLength(1);
    expect(doc.activeElement).toBe(byId("comment-3"));
  });

  it("deduplicates a linked root when ordinary paging reaches it", async () => {
    const mock = answered(thread(3));
    openPage("http://localhost/#comment-3", mock);
    await flush();
    mock.mockResolvedValueOnce({ ok: true, json: async () => ({
      html: thread(3).html + thread(4).html, oldestId: 3, remaining: 0,
    }) });
    byId("comment-load-more").focus();
    byId("comment-load-more").click();
    await flush();
    expect(doc.querySelectorAll("#comment-3")).toHaveLength(1);
    expect(Array.from(byId("comment-list").children).map((node) => node.id)).toEqual([
      "comment-1", "comment-3", "comment-4",
    ]);
    expect(doc.activeElement).toBe(byId("comment-4"));
  });

  it.each(["post", "batch"])("shows a posted reply once when %s answers first", async (first) => {
    const batch = heldResponse();
    let finishPost!: () => void;
    fetchMock.mockImplementation((_url: string, options?: { method?: string }) => {
      if (options?.method === "POST") {
        return new Promise((resolve) => {
          finishPost = () => resolve({ ok: true, text: async () => replyHtml(9) });
        });
      }
      return batch.response;
    });
    // A root loaded through a direct link remains eligible for ordinary
    // paging, which can see the stored reply before its POST response arrives.
    clickReply();
    (byId("content") as HTMLTextAreaElement).value = "reply 9";
    submit();
    byId("comment-load-more").click();
    const finishBatch = () => batch.answer({
      html: `<article class="comment" id="comment-1"><div class="comment-replies" id="replies-1">${replyHtml(9)}</div></article>`,
      oldestId: 1, remaining: 0,
    });

    (first === "post" ? finishPost : finishBatch)();
    await flush();
    const reply = byId("comment-9");
    (first === "post" ? finishBatch : finishPost)();
    await flush();

    expect(doc.querySelectorAll("#comment-9")).toHaveLength(1);
    expect(byId("comment-9")).toBe(reply);
    expect(reply.classList.contains("comment-new")).toBe(true);
    expect(byId("replies-1").contains(reply)).toBe(true);
    expect(doc.querySelector(".comment-count")!.textContent).toBe("(13)");
    expect(doc.activeElement).toBe(reply);
  });
});

const replyPaging = `<div class="comment-load-more comment-replies-more">
  <button class="comment-replies-load" data-game-id="7" data-root-id="1" data-before="60" type="button">
    <span class="comment-replies-idle">Load earlier replies</span>
    <span class="comment-replies-busy" hidden>Loading…</span>
  </button>
  <p class="alert error comment-replies-error" hidden role="alert"></p>
</div>`;
const replyHtml = (id: number) => `<article class="comment comment-reply" id="comment-${id}">reply ${id}</article>`;

describe("comments.js — paging earlier replies", () => {
  beforeEach(() => {
    byId("replies-1").innerHTML = replyPaging + replyHtml(60);
  });
  const button = () => doc.querySelector<HTMLButtonElement>(".comment-replies-load")!;
  const wrap = () => doc.querySelector<HTMLElement>(".comment-replies-more")!;
  const error = () => doc.querySelector<HTMLElement>(".comment-replies-error")!;

  it("loads successive bounded pages in order while keeping the draft", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      html: replyHtml(10) + replyHtml(30), oldestId: 10, remaining: 2,
    }) });
    clickReply();
    (byId("content") as HTMLTextAreaElement).value = "draft";
    button().click();
    await flush();
    expect(fetchMock).toHaveBeenCalledWith("/comments/7/replies/1?before=60");
    expect(Array.from(byId("replies-1").querySelectorAll(":scope > .comment")).map((node) => node.id)).toEqual([
      "comment-10", "comment-30", "comment-60",
    ]);
    expect(button().dataset.before).toBe("10");
    expect(wrap().hidden).toBe(false);
    expect(form().parentElement).toBe(byId("replies-1"));
    expect((byId("content") as HTMLTextAreaElement).value).toBe("draft");
    expect(doc.activeElement).toBe(byId("content"));
  });

  it("deduplicates an already linked reply and focuses new replies at the end", async () => {
    byId("replies-1").insertAdjacentHTML("beforeend", replyHtml(10));
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({
      html: replyHtml(10) + replyHtml(30), oldestId: 10, remaining: 0,
    }) });
    button().focus();
    button().click();
    await flush();
    expect(doc.querySelectorAll("#comment-10")).toHaveLength(1);
    expect(wrap().hidden).toBe(true);
    expect(doc.activeElement).toBe(byId("comment-30"));
    expect(byId("comment-status").textContent).toBe("Earlier replies loaded.");
  });

  it("guards repeated clicks and restores the idle button", async () => {
    let resolve!: (response: unknown) => void;
    fetchMock.mockReturnValue(new Promise((answer) => { resolve = answer; }));
    button().focus();
    button().click();
    button().click();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(button().getAttribute("aria-disabled")).toBe("true");
    expect(doc.activeElement).toBe(button());
    resolve({ ok: true, json: async () => ({ html: replyHtml(30), oldestId: 30, remaining: 1 }) });
    await flush();
    expect(button().hasAttribute("aria-disabled")).toBe(false);
    expect(doc.querySelector<HTMLElement>(".comment-replies-busy")!.hidden).toBe(true);
  });

  it("keeps a failed page in place and retries without clearing posting errors", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "Too many requests" }) });
    byId("comment-error").textContent = "Posting failed";
    byId("comment-error").hidden = false;
    button().focus();
    button().click();
    await flush();
    expect(error().hidden).toBe(false);
    expect(error().textContent).toBe("Too many requests");
    expect(button().dataset.before).toBe("60");
    expect(doc.activeElement).toBe(button());
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ html: "", oldestId: null, remaining: 0 }) });
    button().click();
    await flush();
    expect(error().hidden).toBe(true);
    expect(wrap().hidden).toBe(true);
    expect(doc.activeElement).toBe(byId("comment-60"));
    expect(byId("comment-error").textContent).toBe("Posting failed");
  });

  it("does not expose raw network errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    button().click();
    await flush();
    expect(error().textContent).toBe("Could not load earlier replies. Please try again.");
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
