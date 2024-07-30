// Featured Games Carousel
document.addEventListener("DOMContentLoaded", function () {
  const carousel = document.querySelector(".featured-games-carousel");
  if (!carousel) return;

  const track = carousel.querySelector(".carousel-track");
  const slides = Array.from(carousel.querySelectorAll(".carousel-slide"));
  const prevBtn = carousel.querySelector(".carousel-btn-prev");
  const nextBtn = carousel.querySelector(".carousel-btn-next");
  const indicators = Array.from(
    carousel.querySelectorAll(".carousel-indicator"),
  );

  if (!track || slides.length === 0) return;

  const pauseBtn = carousel.querySelector(".carousel-btn-pause");

  // Someone who has asked their system for less motion has asked for this
  // too: no sliding animation, and the autoplay stays off until they start
  // it themselves with the pause button.
  const reduceMotion = Boolean(
    window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  let currentIndex = 0;
  let slidesPerView = getSlidesPerView();
  let autoplayInterval = null;
  // The visitor's own choice, which hover, touch and tab visibility must not
  // override: those only ever suspend a running autoplay, never restart a
  // paused one.
  let autoplayPaused = reduceMotion;
  // Whether the pointer is resting on the carousel — one of the two things,
  // with focus inside it, that hold the autoplay still (see visitorIsInside).
  // Declared up here with the rest of the state rather than beside the
  // mouseenter listener that sets it: startAutoplay reads it now, and a `let`
  // read before the line declaring it has run throws instead of reading false.
  let pointerInside = false;
  const AUTOPLAY_DELAY = 5000; // 5 seconds

  // Calculate slides per view based on window width
  function getSlidesPerView() {
    const width = window.innerWidth;
    if (width <= 768) return 1;
    if (width <= 1024) return 2;
    if (width <= 1280) return 3;
    return 4;
  }

  // Re-measured on every resize, not only when the slides per view change.
  // The track is moved by a pixel offset worked out from the slide width, and
  // the slides are fluid within each breakpoint, so any change of width leaves
  // the old offset wrong. This used to return early whenever the per-view
  // count came out the same — a phone turned from portrait to landscape is one
  // slide per view either way — and the track stayed stranded between two
  // slides (slide 3 at -560px where -1320px was right) until the next
  // navigation, and indefinitely with the autoplay paused or reduced motion on.
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      slidesPerView = getSlidesPerView();
      // Fewer positions once more slides fit at a time.
      const maxIndex = Math.max(0, slides.length - slidesPerView);
      currentIndex = Math.min(currentIndex, maxIndex);
      // Not animated: this is the layout catching up, not a move the visitor
      // asked for, and with every resize corrected an animation would slide
      // the whole track across the screen each time the phone turned.
      updateCarousel(false);
    }, 200);
  });

  // Update carousel position
  function updateCarousel(animate = true) {
    const slideWidth = slides[0].offsetWidth;
    // Get actual gap from computed styles
    const trackStyle = window.getComputedStyle(track);
    const gap = parseFloat(trackStyle.gap) || 0;
    const offset = -(currentIndex * (slideWidth + gap));

    if (animate && !reduceMotion) {
      track.style.transition = "transform 0.5s ease-in-out";
    } else {
      track.style.transition = "none";
    }

    track.style.transform = `translateX(${offset}px)`;

    // Update indicators - show only valid positions
    const maxIndex = Math.max(0, slides.length - slidesPerView);
    indicators.forEach((indicator, index) => {
      if (index <= maxIndex) {
        indicator.style.display = "";

        const isCurrent = index === currentIndex;

        indicator.classList.toggle("active", isCurrent);

        // The class is a colour and nothing else. aria-current is the half a
        // screen reader can read, and it has to be *removed* rather than set
        // to "false" — aria-current="false" is the absence of the state, but
        // leaving the attribute on every dot means the one that matters has
        // no way to stand out in a list of them.
        if (isCurrent) {
          indicator.setAttribute("aria-current", "true");
        } else {
          indicator.removeAttribute("aria-current");
        }
      } else {
        indicator.style.display = "none";
        indicator.removeAttribute("aria-current");
      }
    });

    updateSlideVisibility();

    // Update button states
    updateButtonStates();
  }

  /**
   * Takes the slides the track has scrolled out of sight out of the page.
   *
   * The track is one long flex row moved by a transform, so every slide is
   * still laid out and still in the tab order — tabbing through the carousel
   * walked into game cards nobody could see, and a screen reader read all ten
   * featured games as though they were on screen. `inert` removes them from
   * both at once; aria-hidden is set alongside it for the assistive tech that
   * does not implement inert yet, and both come off again the moment a slide
   * scrolls back in.
   *
   * Never applied to the slide holding focus: taking the focused element out
   * of the page drops focus to <body>, which is precisely the jump this is
   * meant to prevent. The next updateCarousel picks it up once focus has
   * moved on.
   */
  function updateSlideVisibility() {
    const last = currentIndex + slidesPerView - 1;

    slides.forEach((slide, index) => {
      const visible = index >= currentIndex && index <= last;

      if (!visible && slide.contains(document.activeElement)) return;

      if (visible) {
        slide.inert = false;
        slide.removeAttribute("inert");
        slide.removeAttribute("aria-hidden");
      } else {
        slide.inert = true;
        slide.setAttribute("inert", "");
        slide.setAttribute("aria-hidden", "true");
      }
    });
  }

  // Update button disabled states
  function updateButtonStates() {
    // Buttons are always enabled for infinite loop
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    prevBtn.style.opacity = "1";
    nextBtn.style.opacity = "1";
    prevBtn.style.cursor = "pointer";
    nextBtn.style.cursor = "pointer";
  }

  // Navigate to next slide
  function nextSlide() {
    const maxIndex = Math.max(0, slides.length - slidesPerView);
    if (currentIndex < maxIndex) {
      currentIndex++;
    } else {
      currentIndex = 0; // Loop back to start
    }
    updateCarousel();
    resetAutoplay();
  }

  // Navigate to previous slide
  function prevSlide() {
    const maxIndex = Math.max(0, slides.length - slidesPerView);
    if (currentIndex > 0) {
      currentIndex--;
    } else {
      currentIndex = maxIndex; // Loop to end
    }
    updateCarousel();
    resetAutoplay();
  }

  // Go to specific slide
  function goToSlide(index) {
    const maxIndex = Math.max(0, slides.length - slidesPerView);
    currentIndex = Math.max(0, Math.min(index, maxIndex));
    updateCarousel();
    resetAutoplay();
  }

  /**
   * The two things besides the pause button that hold the autoplay still: the
   * pointer resting on the carousel, and focus anywhere inside it.
   */
  function visitorIsInside() {
    return pointerInside || carousel.contains(document.activeElement);
  }

  // Autoplay functionality
  function startAutoplay() {
    // Always stop any existing interval first to prevent duplicates
    stopAutoplay();

    // The visitor's pause (or their reduced-motion setting) wins over every
    // caller that would otherwise restart it: mouseleave, touchend, the tab
    // coming back, a navigation click.
    if (autoplayPaused) return;

    // And so does the visitor being there at all, which is asked here rather
    // than by each caller. Only the callers that *release* a hold used to ask
    // — mouseleave, focusout, the tab coming back — so every manual navigation
    // (Prev and Next, the dots, the arrow keys, a swipe) reached this through
    // resetAutoplay and restarted the timer that focusin or mouseenter had just
    // stopped: a keyboard visitor pressed Next with focus on it, and five
    // seconds later the track moved on under them (WCAG 2.2.2). The navigation
    // still stops the old interval above, so nothing is left counting down.
    if (visitorIsInside()) return;

    runAutoplay();
  }

  /**
   * The interval itself, with none of startAutoplay's questions asked.
   *
   * Split out for toggleAutoplay, the one caller that must start it with the
   * visitor inside: the pause button is part of the carousel, so whoever
   * presses "Resume autoplay" has the pointer on it and, wherever a click
   * focuses a button, focus on it too — and startAutoplay would decline the
   * one request to move that the visitor makes on purpose. It is also how the
   * WAI-ARIA auto-rotating carousel behaves: rotation stopped by focus comes
   * back when the rotation control is used.
   */
  function runAutoplay() {
    stopAutoplay();

    autoplayInterval = setInterval(() => {
      const maxIndex = Math.max(0, slides.length - slidesPerView);
      if (currentIndex < maxIndex) {
        currentIndex++;
      } else {
        // Loop back to start
        currentIndex = 0;
      }
      updateCarousel();
    }, AUTOPLAY_DELAY);
  }

  function stopAutoplay() {
    if (autoplayInterval) {
      clearInterval(autoplayInterval);
      autoplayInterval = null;
    }
  }

  function resetAutoplay() {
    startAutoplay(); // startAutoplay already calls stopAutoplay
  }

  /**
   * One way of saying what the button does, not two at once.
   *
   * It used to swap its label to "Resume autoplay" *and* set
   * aria-pressed="true", so a screen reader announced "Resume autoplay,
   * toggle button, pressed" — which reads as "resume is on" while the
   * carousel stood still. Each pattern is sound on its own: a toggle button
   * keeps one fixed name and lets aria-pressed carry the state, or an
   * ordinary button's name says what pressing it will do. Mixed, the two
   * contradict each other.
   *
   * The swapped name is the one kept, because it is what the icon beside it
   * has always done — ❚❚ while playing, ▶ while paused, each showing the
   * action the button will take — so what is seen and what is heard say the
   * same thing. It is also the pattern of the WAI-ARIA Authoring Practices'
   * own auto-rotating carousel. aria-pressed would have needed a name and an
   * icon that never change. The attribute is removed rather than set to
   * "false", which would still announce a toggle ("not pressed"); the view
   * no longer renders it, and this clears it from any markup that still
   * does. The ticker's pause button in public/js/ui.js works the same way.
   */
  function renderPauseState() {
    if (!pauseBtn) return;

    pauseBtn.removeAttribute("aria-pressed");
    pauseBtn.setAttribute(
      "aria-label",
      autoplayPaused ? "Resume autoplay" : "Pause autoplay",
    );

    const icon = pauseBtn.querySelector(".carousel-pause-icon");

    if (icon) icon.textContent = autoplayPaused ? "▶" : "❚❚";
  }

  function toggleAutoplay() {
    autoplayPaused = !autoplayPaused;

    renderPauseState();

    if (autoplayPaused) {
      stopAutoplay();
    } else {
      // Not startAutoplay, which would decline: the visitor pressing this is
      // inside the carousel by definition. See runAutoplay.
      runAutoplay();
    }
  }

  if (pauseBtn) {
    pauseBtn.addEventListener("click", toggleAutoplay);
    renderPauseState();
  }

  // Event listeners
  prevBtn.addEventListener("click", prevSlide);
  nextBtn.addEventListener("click", nextSlide);

  indicators.forEach((indicator, index) => {
    indicator.addEventListener("click", () => goToSlide(index));
  });

  // Pause autoplay on hover. pointerInside (declared with the state at the top)
  // is what lets focusout tell "focus left, and nothing else is holding it
  // paused" from "focus left, but the mouse is still sitting on it".
  carousel.addEventListener("mouseenter", () => {
    pointerInside = true;
    stopAutoplay();
  });
  carousel.addEventListener("mouseleave", () => {
    pointerInside = false;

    // Only restart if not already running, so the pointer passing over a
    // carousel that is moving does not reset its timer. startAutoplay itself
    // declines while focus is still inside — the other thing that holds it —
    // and while the pause button is pressed.
    if (!autoplayInterval) {
      startAutoplay();
    }
  });

  // ...and on focus, which is the keyboard's version of the same thing. A
  // visitor tabbing through the slides was reading a carousel that moved out
  // from under them every few seconds — and worse than that, the slide holding
  // focus scrolled out of view and updateSlideVisibility could not make it
  // inert, so the tab order silently disagreed with what was on screen. Pausing
  // for as long as focus is inside costs nothing: the visitor is already
  // driving it with the arrow keys and the buttons.
  carousel.addEventListener("focusin", stopAutoplay);

  // Touch/swipe support
  let touchStartX = 0;
  let touchEndX = 0;

  track.addEventListener(
    "touchstart",
    (e) => {
      touchStartX = e.changedTouches[0].screenX;
      stopAutoplay();
    },
    { passive: true },
  );

  track.addEventListener(
    "touchend",
    (e) => {
      touchEndX = e.changedTouches[0].screenX;
      handleSwipe();
      startAutoplay();
    },
    { passive: true },
  );

  function handleSwipe() {
    const swipeThreshold = 50;
    const diff = touchStartX - touchEndX;

    if (Math.abs(diff) > swipeThreshold) {
      if (diff > 0) {
        nextSlide();
      } else {
        prevSlide();
      }
    }
  }

  // Focus moving out of a slide is the moment the exception in
  // updateSlideVisibility stops applying, so the slide it was holding open
  // can be closed again.
  carousel.addEventListener("focusout", () => {
    // After the browser has settled the new activeElement.
    setTimeout(() => {
      updateSlideVisibility();

      // If focus has left the carousel altogether — not merely moved from one
      // slide to the next — the reason focusin stopped the autoplay is gone.
      // Guarded on the interval like the mouseleave handler above.
      // startAutoplay itself declines while focus is still inside, while a
      // mouse is still resting on the carousel, and while the pause button is
      // pressed.
      if (!autoplayInterval) {
        startAutoplay();
      }
    }, 0);
  });

  // Keyboard navigation
  carousel.addEventListener("keydown", (e) => {
    // A field inside the carousel owns its own arrow keys — they move the
    // caret, or change the value of a <select>. Moving the slide out from
    // under one instead is not something the visitor asked for.
    if (e.target.closest("input, textarea, select")) return;

    if (e.key === "ArrowLeft") {
      // Otherwise the page scrolls sideways at the same time as the slide
      // changes, and a horizontal scroll is the one the browser keeps.
      e.preventDefault();
      prevSlide();
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      nextSlide();
    }
  });

  // Initialize
  updateCarousel(false);
  startAutoplay();

  // Pause autoplay when tab is not visible
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopAutoplay();
      return;
    }

    // Coming back is not on its own a reason to start moving again. This
    // branch restarted unconditionally, so a tab switched away from and back
    // to with the pointer resting on the carousel — or with focus inside one
    // of its slides — resumed under the visitor, undoing the two pauses
    // mouseleave and focusout are careful to respect. startAutoplay now asks
    // about both itself (see visitorIsInside), as well as about the pause
    // button and reduced motion, so it is safe to call from here as it is.
    startAutoplay();
  });
});
