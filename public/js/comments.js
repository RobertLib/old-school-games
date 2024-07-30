/**
 * Comment posting and threaded replies.
 *
 * There is a single form; clicking "Reply" moves it under the comment being
 * answered and remembers the parent id, so a reply is always composed in
 * context without duplicating the form for every comment.
 */
(function () {
  const form = document.getElementById("comment-form");

  if (!form) return;

  const parentInput = document.getElementById("comment-parent-id");
  const replyContext = document.getElementById("comment-reply-context");
  const replyTarget = document.getElementById("comment-reply-target");
  const cancelReply = document.getElementById("comment-cancel-reply");
  const commentList = document.getElementById("comment-list");
  const statusRegion = document.getElementById("comment-status");
  const errorRegion = document.getElementById("comment-error");
  // Looked up explicitly rather than via form.<name>, which reads through the
  // legacy named getter and would collide with real form properties.
  const nickField = form.querySelector('[name="nick"]');
  const contentField = form.querySelector('[name="content"]');
  const gameIdField = form.querySelector('[name="gameId"]');

  const formHome = document.createElement("div");
  form.parentNode.insertBefore(formHome, form);

  const POST_FAILED = "Could not post the comment. Please try again.";
  const LOAD_FAILED = "Could not load earlier comments. Please try again.";
  const REPLIES_FAILED = "Could not load earlier replies. Please try again.";
  const LINK_FAILED = "Could not load the linked comment. Please try again.";

  /**
   * Puts a message in one of the role="alert" boxes, where it is announced
   * once.
   *
   * Once, because the box announces it by itself. The message used to be
   * written into the polite status region as well, so a screen reader read
   * every failure twice over.
   *
   * Revealed before it is written. An alert is announced when what it says
   * changes while it is on the page; text written into it while it is still
   * hidden is not in the accessibility tree to change, and revealing it
   * afterwards is announced by some screen readers and not by others. With
   * the status region no longer standing in for it, "not by others" would be
   * nothing at all.
   */
  function showIn(region, message) {
    region.hidden = false;
    region.textContent = message;
  }

  // Rejections carry a reason ("Content is too long"), so the reader is told
  // what to change rather than being shown a generic failure.
  function showError(message) {
    if (errorRegion) showIn(errorRegion, message);
  }

  function clearError() {
    if (errorRegion) {
      errorRegion.textContent = "";
      errorRegion.hidden = true;
    }
  }

  /**
   * An error whose message is fit to show as it stands: the server's own
   * reason, or one of the fallbacks above. See messageFor.
   */
  function readerError(message) {
    const error = new Error(message);

    error.forReader = true;

    return error;
  }

  /** The reason the server gave, or a fallback if it gave none. */
  function readError(response, fallback) {
    return response
      .json()
      .then((data) => readerError(data?.error || fallback))
      .catch(() => readerError(fallback));
  }

  /**
   * What the reader is told about a request that failed.
   *
   * Only words this file chose or the server gave. Everything else that
   * reaches a catch was going onto the page as it came: a request that never
   * reached the server rejects with the browser's own TypeError — "Failed to
   * fetch" in Chrome, "Load failed" in Safari — and a body that was not JSON
   * throws the parser's SyntaxError. Told apart by the mark readerError puts
   * on its own errors rather than by the error's type, which would miss the
   * SyntaxError, could not tell the network's TypeError from a bug's, and
   * across two realms — a page and a frame, or a test's window — does not
   * hold for instanceof anyway.
   */
  function messageFor(error, fallback) {
    return error?.forReader ? error.message : fallback;
  }

  // The Reply button that opened the form, so cancelling can hand focus back
  // to it. Without that, focus stayed where the form had been detached from
  // and a keyboard user was left somewhere with nothing under the cursor.
  let replyOpener = null;

  // Counts every change to the reply state — a Reply opened, a reply
  // cancelled or reset — so a post that comes back can tell whether the form
  // is still in the state it was sent from. See the submit handler.
  let replyChanges = 0;

  function resetReply(returnFocus) {
    replyChanges += 1;
    parentInput.value = "";
    replyContext.hidden = true;
    replyTarget.textContent = "";

    // Only when the form is actually somewhere else. insertBefore on a node
    // that already sits where it is being put still takes it out of the
    // document and puts it back, and Chrome and WebKit blur whatever had
    // focus inside a subtree the moment it is removed — the re-insert does
    // not give it back. Every successful post comes through here, and a new
    // thread never moved the form at all, so posting one dropped the
    // visitor's focus to <body> for no reason whatsoever.
    if (formHome.nextSibling !== form) {
      formHome.parentNode.insertBefore(form, formHome.nextSibling);
    }

    if (returnFocus && replyOpener && document.contains(replyOpener)) {
      replyOpener.focus();
    }

    replyOpener = null;
  }

  function startReply(commentId, nick) {
    const thread = document.getElementById(`replies-${commentId}`);

    if (!thread) return;

    replyChanges += 1;
    parentInput.value = commentId;
    replyTarget.textContent = nick;
    replyContext.hidden = false;

    thread.appendChild(form);
    contentField.focus();
  }

  // Delegated so replies added after page load get the button too.
  document.addEventListener("click", function (event) {
    const button = event.target.closest(".comment-reply-btn");

    if (!button) return;

    event.preventDefault();
    replyOpener = button;
    startReply(button.dataset.commentId, button.dataset.nick || "anonymous");
  });

  cancelReply.addEventListener("click", () => resetReply(true));

  // ── Loading earlier comments ────────────────────────────────────────────
  const loadMoreButton = document.getElementById("comment-load-more");
  const loadMoreWrap = document.getElementById("comment-load-more-wrap");
  const remainingLabel = document.getElementById("comment-remaining");

  const loadMoreIdle = document.getElementById("comment-load-more-idle");
  const loadMoreBusy = document.getElementById("comment-load-more-busy");
  const loadMoreError = document.getElementById("comment-load-more-error");

  // Two labels are swapped rather than rewriting the button's text, which
  // would throw away the element holding the live remaining count.
  //
  // aria-disabled rather than `disabled`, as on the rating stars (see
  // setStarsBusy in public/js/rating-stars.js). The button is where focus is
  // when it is pressed, and a browser drops focus from a control the moment
  // it is disabled, so every press returned a keyboard visitor to <body> for
  // the length of the request. aria-disabled says "busy" to assistive tech
  // and leaves focus where it is; a second press meanwhile is harmless, since
  // loadEarlierComments hands back the batch already in flight.
  function setLoadingState(busy) {
    if (loadMoreIdle) loadMoreIdle.hidden = busy;
    if (loadMoreBusy) loadMoreBusy.hidden = !busy;

    if (!loadMoreButton) return;

    if (busy) {
      loadMoreButton.setAttribute("aria-disabled", "true");
    } else {
      loadMoreButton.removeAttribute("aria-disabled");
    }
  }

  // A batch's failure is shown beside the button that asked for it. It went
  // to the post form's box — at the foot of the page, far from where the
  // visitor pressed — which also left a post's own error open to being
  // cleared by a batch that loaded. The form's box is used only on markup
  // rendered without this one, which a rolling deploy can pair with this
  // script: the ?v= on its address is not a lock (see utils/assets.ts).
  function showLoadError(message) {
    if (loadMoreError) {
      showIn(loadMoreError, message);
    } else {
      showError(message);
    }
  }

  function clearLoadError() {
    if (loadMoreError) {
      loadMoreError.textContent = "";
      loadMoreError.hidden = true;
    } else {
      clearError();
    }
  }

  // The button keeps focus while busy, so repeated clicks must share the
  // in-flight batch rather than fetching the same cursor twice.
  let pendingBatch = null;

  function newestReply(container) {
    // The server records the end of its complete reply window. A locally
    // posted reply can be newer without covering the intervening replies.
    if (container.dataset.newestReply) return Number(container.dataset.newestReply);
    return Array.from(container.children)
      .filter((node) => node.matches(".comment"))
      .reduce((newest, node) => Math.max(newest, Number(node.id.replace("comment-", "")) || 0), 0);
  }

  function mergeReplyWindow(container, snapshot) {
    const priorNewest = newestReply(container);
    const snapshotNewest = newestReply(snapshot);
    const pager = snapshot.querySelector(":scope > .comment-replies-more");
    const button = pager?.querySelector(".comment-replies-load");
    const livePager = container.querySelector(":scope > .comment-replies-more");

    // Two non-overlapping snapshots leave a gap *above* the live cursor.
    // Give it its own bounded pager, including when the old pager is hidden:
    // reusing that cursor would skip the gap, while resetting it would undo
    // the reader's progress through the older replies.
    if (livePager && priorNewest && Number(button?.dataset.before) > priorNewest) {
      button.dataset.after = String(priorNewest);
      button.querySelector(".comment-replies-idle").textContent = "Load missing replies";
    }

    container.dataset.newestReply = String(Math.max(priorNewest, snapshotNewest));
    return mergeNodes(container, Array.from(snapshot.children));
  }

  // A direct link may have already loaded a root or an old reply that a
  // later page also contains. Merge by id without replacing the live thread:
  // it may hold the reader's focused button or unfinished reply form.
  function mergeNodes(container, nodes) {
    const inserted = [];

    for (const node of nodes) {
      if (node.matches(".comment-replies-more")) {
        // An open thread may have grown past the reply window since it was
        // rendered. Keep its new pager as well as the comments, or the older
        // replies stay unreachable. A live pager keeps its own cursor, busy
        // state and focus; a fresh snapshot must not reset that progress.
        const after = node.querySelector(".comment-replies-load")?.dataset.after;
        const hasPager = Array.from(container.children).some((child) =>
          child.matches(".comment-replies-more") &&
          child.querySelector(".comment-replies-load")?.dataset.after === after,
        );
        if (!hasPager) {
          if (after) {
            const next = Array.from(container.children).find((child) =>
              child.matches(".comment") && Number(child.id.replace("comment-", "")) > Number(after),
            );
            container.insertBefore(node, next || (form.parentNode === container ? form : null));
          } else {
            container.prepend(node);
          }
        }
        continue;
      }
      if (!node.matches(".comment")) continue;
      const existing = node.id && document.getElementById(node.id);

      if (existing) {
        const replies = node.querySelector(".comment-replies");
        const existingReplies = existing.querySelector(".comment-replies");

        if (replies && existingReplies) {
          inserted.push(...mergeReplyWindow(existingReplies, replies));
        }
        continue;
      }

      const id = node.id ? Number(node.id.replace("comment-", "")) : NaN;
      const next = Array.from(container.children).find((child) =>
        child.matches(".comment") && Number(child.id.replace("comment-", "")) > id,
      );

      container.insertBefore(node, next || (form.parentNode === container ? form : null));
      inserted.push(node);
    }

    return inserted;
  }

  function commentNodes(html) {
    const template = document.createElement("template");
    template.innerHTML = html || "";
    return Array.from(template.content.children);
  }

  function mergeComments(container, html) {
    return mergeNodes(container, commentNodes(html));
  }

  /**
   * Fetches the next batch of older comments and puts it above the ones on
   * screen — what the "Load earlier comments" button does.
   *
   * Resolves to true when a batch arrived and there are older ones still to
   * fetch, and to false otherwise: nothing older, no cursor to ask with, or a
   * failure, which has already been shown by the time it resolves.
   */
  function loadEarlierComments() {
    if (pendingBatch) return pendingBatch;

    const before = loadMoreButton.dataset.before;
    const gameId = loadMoreButton.dataset.gameId;

    // A batch already in flight is the pendingBatch above; the button is no
    // longer `disabled` while it waits, so that is the only guard there is.
    if (!before) return Promise.resolve(false);

    setLoadingState(true);

    // Only this button's own message. The post form's error is about the
    // comment being written, and is still true after reading further back.
    clearLoadError();

    pendingBatch = fetch(
      `/comments/${gameId}?before=${encodeURIComponent(before)}`,
    )
      .then((response) => {
        if (!response.ok) {
          return readError(response, LOAD_FAILED).then((error) => {
            throw error;
          });
        }

        return response.json();
      })
      .then((data) => {
        const inserted = mergeComments(commentList, data.html);

        if (data.html) {
          // The dates in that markup are the server's US formatting, and
          // public/js/ui.js rewrites those into the reader's own locale —
          // once, on DOMContentLoaded, which is long before this batch
          // existed. Without this call a thread that had been extended
          // showed "Jan 5, 2026" above "January 5, 2026" in one list. The
          // list itself is the scope, so nothing already rewritten is
          // touched again.
          window.initLocalDates?.(commentList);
        }

        if (data.oldestId) {
          loadMoreButton.dataset.before = data.oldestId;
        }

        if (remainingLabel) {
          remainingLabel.textContent = data.remaining;
        }

        if (!data.remaining) {
          // The button goes with its wrapper, and focus, if the button had
          // it, goes with the button — to <body>, in a browser, for exactly
          // the visitor who pressed it from the keyboard. It is handed to the
          // first comment this batch brought in: where the button was in
          // reading order, and the next thing there is to read. Asked before
          // hiding, while the button still holds focus to be asked about.
          const hadFocus = loadMoreWrap.contains(document.activeElement);

          loadMoreWrap.hidden = true;

          if (hadFocus) {
            const landing =
              inserted[0] || commentList.querySelector(".comment");

            if (landing) focusComment(landing);
          }
        }

        if (statusRegion) {
          statusRegion.textContent = data.remaining
            ? `Earlier comments loaded. ${data.remaining} still older.`
            : "All comments loaded.";
        }

        // "More" only if the cursor actually moved as well. A batch that
        // claimed older comments but named no oldest id would leave the next
        // request asking for this same batch again.
        return Boolean(data.remaining && data.oldestId);
      })
      .catch((error) => {
        showLoadError(messageFor(error, LOAD_FAILED));

        return false;
      })
      .finally(() => {
        pendingBatch = null;
        setLoadingState(false);
      });

    return pendingBatch;
  }

  if (loadMoreButton) {
    loadMoreButton.addEventListener("click", function () {
      loadEarlierComments();
    });
  }

  // Delegation also covers threads inserted by root paging or a direct link.
  const pendingReplies = new WeakSet();

  document.addEventListener("click", async (event) => {
    const button = event.target.closest(".comment-replies-load");
    if (!button || pendingReplies.has(button)) return;

    const wrap = button.closest(".comment-replies-more");
    const container = wrap.parentNode;
    const errorRegion = wrap.querySelector(".comment-replies-error");
    const idle = wrap.querySelector(".comment-replies-idle");
    const busy = wrap.querySelector(".comment-replies-busy");
    const { gameId, rootId, before, after } = button.dataset;
    if (!before) return;

    pendingReplies.add(button);
    button.setAttribute("aria-disabled", "true");
    idle.hidden = true;
    busy.hidden = false;
    errorRegion.hidden = true;
    errorRegion.textContent = "";

    try {
      const response = await fetch(
        `/comments/${gameId}/replies/${rootId}?before=${encodeURIComponent(before)}` +
          (after ? `&after=${encodeURIComponent(after)}` : ""),
      );
      if (!response.ok) throw await readError(response, REPLIES_FAILED);
      const data = await response.json();
      const inserted = mergeComments(container, data.html);
      window.initLocalDates?.(container);
      if (data.oldestId) button.dataset.before = data.oldestId;

      if (!data.remaining) {
        const hadFocus = wrap.contains(document.activeElement);
        wrap.hidden = true;
        const landing = inserted[0] || container.querySelector(".comment");
        if (hadFocus && landing) focusComment(landing);
      }

      if (statusRegion) statusRegion.textContent = "Earlier replies loaded.";
    } catch (error) {
      showIn(errorRegion, messageFor(error, REPLIES_FAILED));
    } finally {
      pendingReplies.delete(button);
      button.removeAttribute("aria-disabled");
      idle.hidden = false;
      busy.hidden = true;
    }
  });

  /**
   * On a long thread the freshly posted comment lands somewhere off screen,
   * so it is scrolled into view and briefly highlighted — otherwise posting
   * looks like nothing happened.
   *
   * scrollIntoView is used rather than window.scrollTo because the comment
   * list is its own scrollbox (max-height + overflow: auto); moving only the
   * window would never bring the comment into view. It walks every scroll
   * container in between, and "nearest" leaves the page alone when the
   * comment is already visible.
   */
  function revealPosted(comment, { scroll = true } = {}) {
    if (!comment) return;

    comment.classList.add("comment-new");

    if (statusRegion) {
      statusRegion.textContent = "Comment posted.";
    }

    // Not when the visitor is busy with a reply of their own elsewhere —
    // see the submit handler.
    if (scroll) scrollToComment(comment, { block: "nearest" });
  }

  /**
   * The scroll half of revealPosted, shared with the walk to a linked comment
   * below — the two moments this file brings a comment to the reader — so
   * both allow for the navbar and for reduced motion the same way.
   */
  function scrollToComment(comment, { block }) {
    const reduced =
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // scrollIntoView knows nothing about the sticky navbar, and its height
    // differs between the three-row phone layout and the desktop one, so it
    // is measured rather than guessed.
    const navbarHeight = document.querySelector(".navbar")?.offsetHeight || 0;
    comment.style.scrollMarginTop = `${navbarHeight + 16}px`;

    comment.scrollIntoView({
      behavior: reduced ? "auto" : "smooth",
      block,
    });
  }

  /**
   * Puts keyboard focus on a comment this file has just brought into view.
   *
   * tabindex="-1" is written here rather than rendered by comment-item.ejs:
   * it lets script focus the article without giving every comment on the
   * page a tab stop of its own, and only the ones landed on need it.
   *
   * preventScroll, because the scroll has already been done: scrollToComment
   * allows for the navbar and animates, and focus()'s own scroll does
   * neither — it would jump the page instantly and cut the smooth one short.
   */
  function focusComment(comment) {
    comment.setAttribute("tabindex", "-1");
    comment.focus({ preventScroll: true });
  }

  /**
   * Adds one to the count in the "Comments (12)" heading.
   *
   * The number is read back out of the heading rather than counted from the
   * DOM: the list is paginated ("load more"), so what is on the page is not
   * the total. A heading with no count yet — the template omits the span
   * when the game has no comments — is left alone; there is nothing to
   * correct, and inventing the element would put it outside the <h2> text
   * the server writes.
   */
  function bumpCommentCount() {
    const countElement = document.querySelector(".comment-count");

    if (!countElement) return;

    const current = Number(countElement.textContent.replace(/\D/g, ""));

    if (!Number.isFinite(current)) return;

    countElement.textContent = `(${current + 1})`;
  }

  form.addEventListener("submit", function (event) {
    event.preventDefault();

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    const parentId = parentInput.value;
    // What is sent, and what the page looked like when it was: the success
    // handler clears and resets only what is still in that state.
    const content = contentField.value;
    const replyState = replyChanges;
    const focusAtSubmit = document.activeElement;

    submitBtn.disabled = true;
    submitBtn.textContent = "Posting...";
    // The textarea stayed editable for the whole request, and the answer then
    // cleared it — so whatever was typed after pressing Post, a second
    // thought begun while the first was sending, was wiped when the answer
    // arrived. Read-only rather than disabled: disabling it would drop focus
    // from it, where readOnly keeps the caret and says "read only" to a
    // screen reader. Given back in the finally below, however it ends.
    contentField.readOnly = true;
    clearError();

    fetch("/comments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token":
          document
            .querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content") || "",
      },
      body: JSON.stringify({
        nick: nickField.value,
        content,
        gameId: gameIdField.value,
        parentId: parentId || null,
      }),
    })
      .then((response) => {
        if (!response.ok) {
          // Anything but a rendered comment is a rejection, and the body says
          // why. Appending it regardless is what used to drop a whole HTML
          // page into the thread.
          return readError(response, POST_FAILED).then((error) => {
            throw error;
          });
        }

        return response.text();
      })
      .then((html) => {
        // Asked before anything below moves the form, which can take focus
        // with it: where focus was when Post was pressed, or nowhere — the
        // disabled button can drop it to <body> — means nobody has moved it.
        const active = document.activeElement;
        const focusStayed =
          !active || active === document.body || active === focusAtSubmit;

        const target = parentId
          ? document.getElementById(`replies-${parentId}`)
          : commentList;

        let posted = null;

        if (target) {
          // A simultaneous thread/page lookup can already contain this
          // stored comment before the POST answers. Use the same merge as
          // reads, then mark and focus the live node even when it was reused.
          const nodes = commentNodes(html);
          const comment = nodes.find((node) => node.matches(".comment"));
          mergeNodes(target, nodes);
          posted = comment?.id ? document.getElementById(comment.id) : comment;

          // The same rewrite the "load earlier" path asks for, for the same
          // reason: public/js/ui.js turns the server's US dates into the
          // reader's locale once, on DOMContentLoaded, and a comment posted
          // afterwards kept "January 5, 2026" under a thread of "Jan 5,
          // 2026". Scoped to the comment itself — it is all that is new.
          window.initLocalDates?.(posted);
        }

        document.getElementById("no-comments")?.remove();

        // The "Comments (12)" heading counts every comment on the game,
        // replies included — it is Comment.countAll (see routes/home.ts and
        // views/games/game-detail.ejs) — so a reply moves it exactly as a
        // new thread does. This used to skip replies on the belief that the
        // number counted root comments only, which left the heading one
        // behind for every reply until the next page load.
        bumpCommentCount();

        // Not form.reset(), which also wipes the nick — so anyone posting a
        // second comment had to type their name again, and most did not,
        // which is why threads are full of one named comment followed by
        // "anonymous". Only the fields that belong to the comment just
        // posted are cleared — and the text only if it is still the text
        // that was posted. readOnly keeps typing out, but typing is not the
        // only thing that writes into a field, and what arrived since is not
        // this comment's to throw away.
        if (contentField.value === content) {
          contentField.value = "";
        }

        // A Reply opened (or cancelled) while this was in flight. The form is
        // where the visitor has just put it and they are writing into it, so
        // the reply state is theirs: resetting it carried the form back to
        // the foot of the page and forgot the comment it had been opened on,
        // and scrolling to the comment just posted, or focusing it, would
        // take them away from what they are writing. It is still marked and
        // announced, for when they get to it.
        if (replyChanges !== replyState) {
          revealPosted(posted, { scroll: false });
          return;
        }

        parentInput.value = "";
        // Runs before the scroll so the form is back in place and the
        // measured position is the final one.
        resetReply();
        revealPosted(posted);

        // Somebody who moved focus on while this was in flight — into the
        // nick field, say — is not pulled out of it mid-word; the same
        // courtesy the walk to a linked comment below extends.
        if (!focusStayed) return;

        // Focus goes to the comment just posted. Something has to take it:
        // the submit button was disabled for the length of the request, and
        // a reply's form has just been carried from its thread back to the
        // foot of the page — either one can leave the browser with focus on
        // <body>. The comment rather than the emptied textarea because it is
        // what was just scrolled into view (a reply's textarea is now at the
        // bottom of what may be a long thread, so focusing it would scroll
        // away from the reply or leave focus off screen), and because it is
        // the one thing on the page that changed: a screen reader starts
        // from what was written, the live region confirms it went through,
        // and the next Tab carries on into the thread. The textarea only
        // when there is no comment to land on — the thread it answered has
        // gone from the page.
        if (posted) {
          focusComment(posted);
        } else {
          contentField.focus();
        }
      })
      .catch((error) => {
        showError(messageFor(error, POST_FAILED));
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
        contentField.readOnly = false;
      });
  });

  // A single bounded thread lookup reaches both very old roots and replies
  // outside the initial fifty. Root pagination cannot find the latter.
  const linkErrorWrap = document.getElementById("comment-link-error-wrap");
  const linkError = document.getElementById("comment-link-error");
  const linkRetry = document.getElementById("comment-link-retry");
  let linkRequest = 0;
  const pendingLinks = new Map();

  function loadLinkedThread(commentId) {
    if (pendingLinks.has(commentId)) return pendingLinks.get(commentId);

    const pending = fetch(`/comments/${gameIdField.value}/thread/${commentId}`)
      .then(async (response) => {
        if (!response.ok) throw await readError(response, LINK_FAILED);
        return response.json();
      })
      .finally(() => pendingLinks.delete(commentId));
    pendingLinks.set(commentId, pending);
    return pending;
  }

  function revealLinkedComment(retry = false) {
    // A superseded response must neither insert nor focus its old target.
    const request = ++linkRequest;
    linkRetry?.removeAttribute("aria-disabled");
    // A retry must keep its focused button until the target arrives. Hiding
    // its wrapper immediately would drop keyboard focus during the request.
    if (linkErrorWrap && (!retry || document.activeElement !== linkRetry)) {
      linkErrorWrap.hidden = true;
    }
    document
      .querySelectorAll(".comment-linked")
      .forEach((comment) => comment.classList.remove("comment-linked"));

    const match = /^#comment-(\d+)$/.exec(window.location.hash);
    if (!match) return;
    const id = `comment-${match[1]}`;
    if (document.getElementById(id)) return;

    const focusAtStart = document.activeElement;
    linkRetry?.setAttribute("aria-disabled", "true");
    loadLinkedThread(match[1])
      .then((data) => {
        if (request !== linkRequest) return;
        mergeComments(commentList, data.html);
        window.initLocalDates?.(commentList);
        const comment = document.getElementById(id);
        if (!comment) throw readerError("Comment not found.");
        comment.classList.add("comment-linked");

        // Do not interrupt someone who started typing while the request ran.
        if (document.activeElement === focusAtStart) {
          scrollToComment(comment, { block: "start" });
          focusComment(comment);
        }
        if (linkErrorWrap) linkErrorWrap.hidden = true;
      })
      .catch((error) => {
        if (request !== linkRequest) return;
        const message = messageFor(error, LINK_FAILED);
        if (linkErrorWrap && linkError) {
          linkErrorWrap.hidden = false;
          showIn(linkError, message);
        } else {
          showError(message);
        }
      })
      .finally(() => {
        if (request === linkRequest) linkRetry?.removeAttribute("aria-disabled");
      });
  }

  linkRetry?.addEventListener("click", () => {
    if (!linkRetry.hasAttribute("aria-disabled")) revealLinkedComment(true);
  });
  revealLinkedComment();
  window.addEventListener("hashchange", () => revealLinkedComment());
})();
