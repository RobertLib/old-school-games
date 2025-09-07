document.addEventListener("DOMContentLoaded", function () {
  if (!localStorage.getItem("favoriteGames")) {
    localStorage.setItem("favoriteGames", JSON.stringify([]));
  }

  if (!localStorage.getItem("recentlyPlayedGames")) {
    localStorage.setItem("recentlyPlayedGames", JSON.stringify([]));
  }

  updateFavoritesCount();

  document.querySelectorAll(".favorite-btn").forEach((btn) => {
    const gameId = btn.dataset.gameId;
    const isLiked = isFavorite(gameId);
    updateFavoriteButton(btn, isLiked);

    btn.addEventListener("click", function (event) {
      event.preventDefault();
      toggleFavorite(btn);
    });
  });
});

function isFavorite(gameId) {
  const favorites = JSON.parse(localStorage.getItem("favoriteGames") || "[]");
  return favorites.some((game) => game.id === gameId);
}

function toggleFavorite(button) {
  const gameId = button.dataset.gameId;
  const gameTitle = button.dataset.gameTitle;
  const gameSlug = button.dataset.gameSlug;
  const gameImage = button.dataset.gameImage;
  const gameDescription = button.dataset.gameDescription;

  const favorites = JSON.parse(localStorage.getItem("favoriteGames") || "[]");
  const isCurrentlyLiked = isFavorite(gameId);

  if (isCurrentlyLiked) {
    const newFavorites = favorites.filter((game) => game.id !== gameId);
    localStorage.setItem("favoriteGames", JSON.stringify(newFavorites));
    updateFavoriteButton(button, false);
  } else {
    favorites.push({
      id: gameId,
      title: gameTitle,
      slug: gameSlug,
      image: gameImage,
      description: gameDescription,
    });
    localStorage.setItem("favoriteGames", JSON.stringify(favorites));
    updateFavoriteButton(button, true);

    button.classList.add("animate");
    setTimeout(() => {
      button.classList.remove("animate");
    }, 600);
  }

  updateFavoritesCount();
}

function updateFavoriteButton(button, isLiked) {
  if (isLiked) {
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
        <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
      </svg>`;
    button.classList.add("liked");
  } else {
    button.innerHTML = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="18" height="18">
        <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z" />
      </svg>`;
    button.classList.remove("liked");
  }
}

function updateFavoritesCount() {
  const favorites = JSON.parse(localStorage.getItem("favoriteGames") || "[]");
  const countElement = document.getElementById("favorites-count");
  if (countElement) {
    countElement.textContent = favorites.length;

    if (favorites.length === 0) {
      countElement.style.display = "none";
    } else {
      countElement.style.display = "inline";
    }
  }
}

function addToRecentlyPlayed(gameData) {
  const recentlyPlayed = JSON.parse(
    localStorage.getItem("recentlyPlayedGames") || "[]"
  );

  const filteredGames = recentlyPlayed.filter(
    (game) => game.id !== gameData.id
  );

  filteredGames.unshift({
    ...gameData,
    playedAt: new Date().toISOString(),
  });

  const limitedGames = filteredGames.slice(0, 10);

  localStorage.setItem("recentlyPlayedGames", JSON.stringify(limitedGames));
}

function loadFavoriteGames() {
  const favorites = JSON.parse(localStorage.getItem("favoriteGames") || "[]");
  const container = document.getElementById("favorite-games-container");

  if (!container) return;

  if (favorites.length === 0) {
    container.innerHTML =
      "<p>You don't have any favorite games. Add some by clicking the heart icon next to the game!</p>";
    return;
  }

  let html = '<div class="game-list">';

  favorites.forEach((game) => {
    html += `
      <article class="game-item card">
        <div>
          <a class="color-primary font-bold" href="/${game.slug}">
            <h3 class="text-lg" style="margin: 0">${game.title}</h3>
          </a>
          <div class="clearfix">
            <a class="game-item-initial" href="/${game.slug}">
              <img alt="${game.title}" loading="lazy" src="${
                game.image
              }" width="100" />
            </a>
            <div>${
              game.description ||
              'A classic MS-DOS game that you have added to your favorites. Click the "Show game" button to view details and play.'
            }</div>
          </div>
          <div class="flex" style="justify-content: space-between; margin-top: 10px; width: 100%">
            <a class="btn btn-sm" href="/${game.slug}">Show game</a>
            <button class="favorite-btn liked"
              data-game-id="${game.id}"
              data-game-title="${game.title}"
              data-game-slug="${game.slug}"
              data-game-image="${game.image}"
              title="Favorite"
              type="button">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="18" height="18">
                <path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0l-.003-.001z" />
              </svg>
            </button>
          </div>
        </div>
      </article>
    `;
  });

  html += "</div>";
  container.innerHTML = html;

  container.querySelectorAll(".favorite-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      toggleFavorite(btn);
      setTimeout(loadFavoriteGames, 100);
    });
  });
}

function removeFromRecentlyPlayed(gameId) {
  const recentlyPlayed = JSON.parse(
    localStorage.getItem("recentlyPlayedGames") || "[]"
  );

  const filteredGames = recentlyPlayed.filter((game) => game.id !== gameId);
  localStorage.setItem("recentlyPlayedGames", JSON.stringify(filteredGames));
}

function loadRecentlyPlayedGames() {
  const recentlyPlayed = JSON.parse(
    localStorage.getItem("recentlyPlayedGames") || "[]"
  );
  const container = document.getElementById("recently-played-games-container");

  if (!container) return;

  if (recentlyPlayed.length === 0) {
    container.innerHTML =
      "<p>You haven't played any games yet. Start playing to see your recently played games here!</p>";
    return;
  }

  let html = '<div class="game-list">';

  recentlyPlayed.forEach((game) => {
    const playedDate = new Date(game.playedAt).toLocaleDateString('en-US');
    html += `
      <article class="game-item card">
        <div>
          <a class="color-primary font-bold" href="/${game.slug}">
            <h3 class="text-lg" style="margin: 0">${game.title}</h3>
          </a>
          <div class="clearfix">
            <a class="game-item-initial" href="/${game.slug}">
              <img alt="${game.title}" loading="lazy" src="${
                game.image
              }" width="100" />
            </a>
            <div>${
              game.description ||
              'A classic MS-DOS game that you have recently played. Click the "Show game" button to play again.'
            }</div>
          </div>
          <div class="text-sm" style="margin-top: 8px;">
            <strong>Last played:</strong> ${playedDate}
          </div>
          <div class="flex" style="justify-content: space-between; margin-top: 10px; width: 100%">
            <a class="btn btn-sm" href="/${game.slug}">Play again</a>
            <button class="remove-recently-played-btn"
              data-game-id="${game.id}"
              title="Remove from recently played"
              type="button"
              style="background: none; border: none; color: #666; cursor: pointer; padding: 4px 8px; font-size: 12px; display: flex; align-items: center; gap: 4px; transition: color 0.3s ease;">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="14" height="14">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Remove
            </button>
          </div>
        </div>
      </article>
    `;
  });

  html += "</div>";
  container.innerHTML = html;

  // Add event listeners for remove buttons
  container.querySelectorAll(".remove-recently-played-btn").forEach((btn) => {
    btn.addEventListener("click", function () {
      const gameId = btn.dataset.gameId;
      removeFromRecentlyPlayed(gameId);
      loadRecentlyPlayedGames(); // Reload the list
    });

    // Add hover effects
    btn.addEventListener("mouseenter", function () {
      btn.style.color = "#ff4444";
    });

    btn.addEventListener("mouseleave", function () {
      btn.style.color = "#666";
    });
  });
}

window.addGameToRecentlyPlayed = function (
  gameId,
  gameTitle,
  gameSlug,
  gameImage,
  gameDescription
) {
  addToRecentlyPlayed({
    id: gameId,
    title: gameTitle,
    slug: gameSlug,
    image: gameImage,
    description: gameDescription,
  });
};
