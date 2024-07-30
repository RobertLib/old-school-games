const STARS = 5;

class RatingStars extends HTMLElement {
  constructor() {
    super();

    this.attachShadow({ mode: "open" });

    this.template = document.createElement("template");
  }

  connectedCallback() {
    const rating = parseInt(this.getAttribute("rating"), 10) || 0;
    const gameId = this.getAttribute("gameId");

    this.render(rating);

    this.shadowRoot.addEventListener("click", (event) => {
      const newRating =
        Array.from(this.shadowRoot.querySelectorAll(".star")).indexOf(
          event.target.closest(".star")
        ) + 1;

      this.submitRating(gameId, newRating);
    });
  }

  render(rating) {
    this.template.innerHTML = `
      <style>
        .star {
          color: lightgray;
          cursor: pointer;
          display: inline-block;
          transition: all 0.2s ease;
        }
        .star:hover {
          transform: scale(1.25);
        }
        .star:hover,
        .star:has(~ .star:hover),
        .star.selected {
          color: gold;
        }
        .star:hover ~ .star {
          color: lightgray;
        }
      </style>
      ${Array(STARS)
        .fill(
          `<svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 576 512"
            fill="currentColor"
            width="15"
            height="15"
          >
            <path
              d="M316.9 18C311.6 7 300.4 0 288.1 0s-23.4 7-28.8 18L195 150.3 51.4 171.5c-12 1.8-22 10.2-25.7 21.7s-.7 24.2 7.9 32.7L137.8 329 113.2 474.7c-2 12 3 24.2 12.9 31.3s23 8 33.8 2.3l128.3-68.5 128.3 68.5c10.8 5.7 23.9 4.9 33.8-2.3s14.9-19.3 12.9-31.3L438.5 329 542.7 225.9c8.6-8.5 11.7-21.2 7.9-32.7s-13.7-19.9-25.7-21.7L381.2 150.3 316.9 18z"
            />
          </svg>`
        )
        .map((star, index) => {
          return `<span class="star ${
            index < rating ? "selected" : ""
          }" role="button" aria-label="Rating ${
            index + 1
          } out of 5">${star}</span>`;
        })
        .join("")}
    `;

    this.shadowRoot.innerHTML = this.template.innerHTML;
  }

  async submitRating(gameId, rating) {
    try {
      const response = await fetch(`/games/${gameId}/rate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ rating }),
      });

      if (response.ok) {
        const { averageRating } = await response.json();

        this.render(averageRating);

        alert(`You rated this game ${rating} stars!`);
      } else {
        const errorData = await response.json();
        alert(errorData.error || "Failed to submit rating.");
      }
    } catch (error) {
      console.error("Error submitting rating:", error);
      alert("Error submitting rating.");
    }
  }
}

customElements.define("rating-stars", RatingStars);
