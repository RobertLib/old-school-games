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

  // Rejections carry a reason ("Content is too long"), so the reader is told
  // what to change rather than being shown a generic failure.
  function showError(message) {
    if (errorRegion) {
      errorRegion.textContent = message;
      errorRegion.hidden = false;
    }

    if (statusRegion) {
      statusRegion.textContent = message;
    }
  }

  function clearError() {
    if (errorRegion) {
      errorRegion.textContent = "";
      errorRegion.hidden = true;
    }
  }

  /** The reason the server gave, or a fallback if it gave none. */
  function readError(response, fallback) {
    return response
      .json()
      .then((data) => new Error(data?.error || fallback))
      .catch(() => new Error(fallback));
  }

  // The Reply button that opened the form, so cancelling can hand focus back
  // to it. Without that, focus stayed where the form had been detached from
  // and a keyboard user was left somewhere with nothing under the cursor.
  let replyOpener = null;

  function resetReply(returnFocus) {
    parentInput.value = "";
    replyContext.hidden = true;
    replyTarget.textContent = "";
    formHome.parentNode.insertBefore(form, formHome.nextSibling);

    if (returnFocus && replyOpener && document.contains(replyOpener)) {
      replyOpener.focus();
    }

    replyOpener = null;
  }

  function startReply(commentId, nick) {
    const thread = document.getElementById(`replies-${commentId}`);

    if (!thread) return;

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

  // Two labels are swapped rather than rewriting the button's text, which
  // would throw away the element holding the live remaining count.
  function setLoadingState(busy) {
    if (loadMoreIdle) loadMoreIdle.hidden = busy;
    if (loadMoreBusy) loadMoreBusy.hidden = !busy;
    if (loadMoreButton) loadMoreButton.disabled = busy;
  }

  if (loadMoreButton) {
    loadMoreButton.addEventListener("click", function () {
      const before = loadMoreButton.dataset.before;
      const gameId = loadMoreButton.dataset.gameId;

      if (!before || loadMoreButton.disabled) return;

      setLoadingState(true);

      clearError();

      fetch(`/comments/${gameId}?before=${encodeURIComponent(before)}`)
        .then((response) => {
          if (!response.ok) {
            return readError(
              response,
              "Could not load earlier comments. Please try again.",
            ).then((error) => {
              throw error;
            });
          }

          return response.json();
        })
        .then((data) => {
          if (data.html) {
            // The button sits above the list, so prepending happens below
            // everything already on screen: nothing moves, and the newly
            // loaded comments appear right where the reader is looking.
            commentList.insertAdjacentHTML("afterbegin", data.html);
          }

          if (data.oldestId) {
            loadMoreButton.dataset.before = data.oldestId;
          }

          if (remainingLabel) {
            remainingLabel.textContent = data.remaining;
          }

          if (!data.remaining) {
            loadMoreWrap.hidden = true;
          }

          if (statusRegion) {
            statusRegion.textContent = data.remaining
              ? `Earlier comments loaded. ${data.remaining} still older.`
              : "All comments loaded.";
          }
        })
        .catch((error) => {
          showError(error.message);
        })
        .finally(() => setLoadingState(false));
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
  function revealPosted(comment) {
    if (!comment) return;

    comment.classList.add("comment-new");

    if (statusRegion) {
      statusRegion.textContent = "Comment posted.";
    }

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
      block: "nearest",
    });
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

    submitBtn.disabled = true;
    submitBtn.textContent = "Posting...";
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
        content: contentField.value,
        gameId: gameIdField.value,
        parentId: parentId || null,
      }),
    })
      .then((response) => {
        if (!response.ok) {
          // Anything but a rendered comment is a rejection, and the body says
          // why. Appending it regardless is what used to drop a whole HTML
          // page into the thread.
          return readError(
            response,
            "Could not post the comment. Please try again.",
          ).then((error) => {
            throw error;
          });
        }

        return response.text();
      })
      .then((html) => {
        const target = parentId
          ? document.getElementById(`replies-${parentId}`)
          : commentList;

        let posted = null;

        if (target) {
          target.insertAdjacentHTML("beforeend", html);
          posted = target.lastElementChild;
        }

        document.getElementById("no-comments")?.remove();

        // The "Comments (12)" heading counts root comments (see
        // views/games/game-detail.ejs), so a new one leaves it a comment
        // behind until the next page load. A reply does not change it.
        if (!parentId) bumpCommentCount();

        // Not form.reset(), which also wipes the nick — so anyone posting a
        // second comment had to type their name again, and most did not,
        // which is why threads are full of one named comment followed by
        // "anonymous". Only the fields that belong to the comment just
        // posted are cleared.
        contentField.value = "";
        parentInput.value = "";
        // Runs before the scroll so the form is back in place and the
        // measured position is the final one.
        resetReply();
        revealPosted(posted);
      })
      .catch((error) => {
        showError(error.message);
      })
      .finally(() => {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      });
  });
})();
