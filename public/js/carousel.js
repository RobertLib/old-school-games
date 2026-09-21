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
  const AUTOPLAY_DELAY = 5000; // 5 seconds

  // Calculate slides per view based on window width
  function getSlidesPerView() {
    const width = window.innerWidth;
    if (width <= 768) return 1;
    if (width <= 1024) return 2;
    if (width <= 1280) return 3;
    return 4;
  }

  // Update slides per view on window resize
  let resizeTimeout;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      const newSlidesPerView = getSlidesPerView();
      if (newSlidesPerView !== slidesPerView) {
        slidesPerView = newSlidesPerView;
        // Adjust current index if needed
        const maxIndex = Math.max(0, slides.length - slidesPerView);
        currentIndex = Math.min(currentIndex, maxIndex);
        updateCarousel();
      }
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

  // Autoplay functionality
  function startAutoplay() {
    // Always stop any existing interval first to prevent duplicates
    stopAutoplay();

    // The visitor's pause (or their reduced-motion setting) wins over every
    // caller that would otherwise restart it: mouseleave, touchend, the tab
    // coming back, a navigation click.
    if (autoplayPaused) return;

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

  function renderPauseState() {
    if (!pauseBtn) return;

    pauseBtn.setAttribute("aria-pressed", autoplayPaused ? "true" : "false");
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
      startAutoplay();
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

  // Pause autoplay on hover
  carousel.addEventListener("mouseenter", stopAutoplay);
  carousel.addEventListener("mouseleave", () => {
    // Only restart if not already running
    if (!autoplayInterval) {
      startAutoplay();
    }
  });

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
    setTimeout(updateSlideVisibility, 0);
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
    } else {
      startAutoplay();
    }
  });
});
