document.addEventListener("DOMContentLoaded", function () {
  initExpandedDescriptions();
  initHoverEffects();
  initLoadingStates();
  initLocalDates();
  initTicker();
});

function initTicker() {
  const wrap = document.querySelector(".ticker-wrap");
  const ticker = document.querySelector(".ticker");
  if (!wrap || !ticker) return;

  const speed = 80; // px per second
  let pos = wrap.offsetWidth;
  let last = null;

  // Set initial position before making visible to avoid flash at pos 0
  ticker.style.transform = "translateX(" + pos + "px)";
  ticker.style.visibility = "visible";

  function step(ts) {
    if (last !== null) {
      pos -= (speed * (ts - last)) / 1000;
      if (pos < -ticker.offsetWidth) {
        pos = wrap.offsetWidth;
      }
      ticker.style.transform = "translateX(" + pos + "px)";
    }
    last = ts;
    requestAnimationFrame(step);
  }

  requestAnimationFrame(step);
}

function initLocalDates() {
  document.querySelectorAll("[data-date]").forEach((el) => {
    el.textContent = new Date(el.dataset.date).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  });
}

function initExpandedDescriptions() {
  document.querySelectorAll(".description .more-btn").forEach((moreBtn) => {
    moreBtn.addEventListener("click", function () {
      const description = this.closest(".description");

      if (description.classList.contains("expanded")) {
        description.classList.remove("expanded");
        this.textContent = "more...";
      } else {
        description.classList.add("expanded");
        this.textContent = "...less";
      }
    });
  });
}

function initHoverEffects() {
  document.querySelectorAll(".btn").forEach((btn) => {
    btn.addEventListener("mouseenter", function () {
      this.style.transform = "translateY(-1px)";
    });

    btn.addEventListener("mouseleave", function () {
      this.style.transform = "translateY(0)";
    });
  });
}

function initLoadingStates() {
  document.querySelectorAll("form").forEach((form) => {
    form.addEventListener("submit", function () {
      const submitBtn = this.querySelector('button[type="submit"]');
      if (submitBtn && !submitBtn.disabled) {
        submitBtn.disabled = true;

        setTimeout(() => {
          submitBtn.disabled = false;
        }, 5000);
      }
    });
  });
}

document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
  anchor.addEventListener("click", function (event) {
    event.preventDefault();
    const target = document.querySelector(this.getAttribute("href"));
    if (target) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  });
});
