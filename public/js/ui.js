document.addEventListener("DOMContentLoaded", function () {
  initExpandedDescriptions();
  initHoverEffects();
  initLoadingStates();
});

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
