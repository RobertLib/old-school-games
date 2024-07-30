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

  // The batch on its way, if one is. There are two ways to ask for a batch
  // now — the button, and the walk towards a linked comment further down —
  // and this is the one guard for both: a second request for the same
  // cursor would prepend the same batch twice. A caller that arrives while
  // one is in flight is handed that request rather than refused, so the
  // walk waits on a batch the visitor asked for instead of giving up on it.
  let pendingBatch = null;

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
        // What was at the top before this batch, so that the first comment
        // it brings in can be told apart afterwards.
        const previousFirst = commentList.firstElementChild;

        if (data.html) {
          // The button sits above the list, so prepending happens below
          // everything already on screen: nothing moves, and the newly
          // loaded comments appear right where the reader is looking.
          commentList.insertAdjacentHTML("afterbegin", data.html);

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
            const firstInserted =
              commentList.firstElementChild !== previousFirst
                ? commentList.firstElementChild
                : null;
            const landing =
              firstInserted || commentList.querySelector(".comment");

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
          target.insertAdjacentHTML("beforeend", html);
          posted = target.lastElementChild;

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

  // ── Links to a comment that is not on the page yet ──────────────────────
  /**
   * /some-game#comment-123, where comment 123 is older than the batch the
   * page was rendered with.
   *
   * The sidebar's "Latest comments" and the /comments overview both link
   * straight to a comment (views/right-sidebar.ejs,
   * views/comments/comments-index.ejs), but this page renders only the newest
   * threads and everything older arrives through "Load earlier comments". A
   * link to an older thread, or to a reply in one, therefore landed at the top
   * of the page with nothing to show for it: the browser had no element to
   * scroll to, and :target had nothing to mark.
   *
   * So the comment is fetched the way a reader would fetch it — batch by
   * batch through loadEarlierComments, the button's own path and its own
   * in-flight guard — until it turns up or there is nothing older. Bounded,
   * because a link can name a comment no batch will ever carry (a deleted
   * one, or a reply past its thread's REPLIES_PER_ROOT cap in
   * models/comment.ts), and following that to the end of a long thread would
   * fetch the whole thread for nothing. If it never turns up, the page is
   * left as those batches built it: nothing is scrolled, focused or reported.
   */
  const LINKED_COMMENT_BATCH_LIMIT = 20;

  // Bumped by every walk, so one that a later hashchange has superseded
  // stops at its next step instead of scrolling to a comment the reader has
  // since navigated away from.
  let linkWalk = 0;

  function revealLinkedComment() {
    // Taken first, before any of the ways out below: whatever the fragment
    // now says, a walk still under way for the previous one is over — even
    // when the new one names a comment that is already on the page.
    const walk = ++linkWalk;

    // A comment an earlier walk landed on is not the linked one any more.
    // :target moves by itself when the fragment changes; this class does not.
    document
      .querySelectorAll(".comment-linked")
      .forEach((comment) => comment.classList.remove("comment-linked"));

    // Only the shape those two links produce. Any other fragment —
    // #comments, a heading — is the browser's to handle.
    const match = /^#comment-(\d+)$/.exec(window.location.hash);

    if (!match || !loadMoreButton) return;

    const id = `comment-${match[1]}`;

    // Already on the page: the browser has scrolled to it, :target marks it,
    // and public/js/ui.js re-lands on it once the layout has settled.
    if (document.getElementById(id)) return;

    // Where focus was when the walk began. If it has moved by the time the
    // comment arrives, the reader has started on something else — typing a
    // comment of their own, say — and being scrolled away and having focus
    // pulled out of a field mid-word would be worse than the missing jump.
    const focusAtStart = document.activeElement;
    let batches = 0;

    const step = () => {
      if (walk !== linkWalk) return;

      const comment = document.getElementById(id);

      if (comment) {
        // What .comment:target in public/css/style.css draws for a comment
        // that was on the page from the start. :target itself cannot match
        // this one: the browser settled which element the fragment names
        // before it existed, and does not look again.
        comment.classList.add("comment-linked");

        if (document.activeElement === focusAtStart) {
          // "start", as the browser's own jump to a fragment would have
          // placed it and as ui.js re-lands one.
          scrollToComment(comment, { block: "start" });
          focusComment(comment);
        }

        return;
      }

      if (loadMoreWrap?.hidden || batches >= LINKED_COMMENT_BATCH_LIMIT) {
        return;
      }

      batches += 1;

      loadEarlierComments().then((more) => {
        // The batch that just arrived can hold it even when it was the last
        // one there is.
        if (more || document.getElementById(id)) step();
      });
    };

    step();
  }

  revealLinkedComment();

  // A second link on the same page — the sidebar is on every game page, and
  // may well point at another comment on this one — changes only the
  // fragment, so no new page load comes along to start a walk for it.
  window.addEventListener("hashchange", revealLinkedComment);
})();
