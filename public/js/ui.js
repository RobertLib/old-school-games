document.addEventListener("DOMContentLoaded", function () {
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
});
