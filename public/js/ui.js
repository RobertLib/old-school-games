document.addEventListener("DOMContentLoaded", function () {
  initExpandedDescriptions();
  initScrollAnimations();
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

function initScrollAnimations() {
  const observerOptions = {
    threshold: 0.1,
    rootMargin: "0px 0px 0px 0px",
  };

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.style.opacity = "1";
        entry.target.style.transform = "translateY(0)";
      }
    });
  }, observerOptions);

  document.querySelectorAll(".card").forEach((item, index) => {
    item.style.opacity = "0";
    item.style.transform = "translateY(20px)";
    item.style.transition = `opacity 0.25s ease 0.025s, transform 0.25s ease 0.025s`;
    observer.observe(item);
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
        const originalText = submitBtn.textContent;
        submitBtn.textContent = "Loading...";
        submitBtn.disabled = true;

        setTimeout(() => {
          submitBtn.textContent = originalText;
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
