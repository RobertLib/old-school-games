// Featured Games Carousel
document.addEventListener('DOMContentLoaded', function() {
  const carousel = document.querySelector('.featured-games-carousel');
  if (!carousel) return;

  const track = carousel.querySelector('.carousel-track');
  const slides = Array.from(carousel.querySelectorAll('.carousel-slide'));
  const prevBtn = carousel.querySelector('.carousel-btn-prev');
  const nextBtn = carousel.querySelector('.carousel-btn-next');
  const indicators = Array.from(carousel.querySelectorAll('.carousel-indicator'));

  if (!track || slides.length === 0) return;

  let currentIndex = 0;
  let slidesPerView = getSlidesPerView();
  let autoplayInterval = null;
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
  window.addEventListener('resize', () => {
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

    if (animate) {
      track.style.transition = 'transform 0.5s ease-in-out';
    } else {
      track.style.transition = 'none';
    }

    track.style.transform = `translateX(${offset}px)`;

    // Update indicators - show only valid positions
    const maxIndex = Math.max(0, slides.length - slidesPerView);
    indicators.forEach((indicator, index) => {
      if (index <= maxIndex) {
        indicator.style.display = '';
        indicator.classList.toggle('active', index === currentIndex);
      } else {
        indicator.style.display = 'none';
      }
    });

    // Update button states
    updateButtonStates();
  }

  // Update button disabled states
  function updateButtonStates() {
    // Buttons are always enabled for infinite loop
    prevBtn.disabled = false;
    nextBtn.disabled = false;
    prevBtn.style.opacity = '1';
    nextBtn.style.opacity = '1';
    prevBtn.style.cursor = 'pointer';
    nextBtn.style.cursor = 'pointer';
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

  // Event listeners
  prevBtn.addEventListener('click', prevSlide);
  nextBtn.addEventListener('click', nextSlide);

  indicators.forEach((indicator, index) => {
    indicator.addEventListener('click', () => goToSlide(index));
  });

  // Pause autoplay on hover
  carousel.addEventListener('mouseenter', stopAutoplay);
  carousel.addEventListener('mouseleave', () => {
    // Only restart if not already running
    if (!autoplayInterval) {
      startAutoplay();
    }
  });

  // Touch/swipe support
  let touchStartX = 0;
  let touchEndX = 0;

  track.addEventListener('touchstart', (e) => {
    touchStartX = e.changedTouches[0].screenX;
    stopAutoplay();
  }, { passive: true });

  track.addEventListener('touchend', (e) => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
    startAutoplay();
  }, { passive: true });

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

  // Keyboard navigation
  carousel.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') {
      prevSlide();
    } else if (e.key === 'ArrowRight') {
      nextSlide();
    }
  });

  // Initialize
  updateCarousel(false);
  startAutoplay();

  // Pause autoplay when tab is not visible
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopAutoplay();
    } else {
      startAutoplay();
    }
  });
});
