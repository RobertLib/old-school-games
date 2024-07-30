/**
 * Internal link helper functions to improve SEO by adding contextual links
 */

interface InternalLinkContext {
  genre?: string;
  developer?: string;
  publisher?: string;
  year?: number;
  game?: any;
}

export function generateContextualLinks(
  context: InternalLinkContext
): Array<{ url: string; text: string; priority: number }> {
  const links: Array<{ url: string; text: string; priority: number }> = [];

  // Always include main navigation links
  links.push(
    { url: "/", text: "All Games", priority: 0.9 },
    { url: "/developers", text: "Game Developers", priority: 0.8 },
    { url: "/publishers", text: "Game Publishers", priority: 0.8 },
    { url: "/years", text: "Browse by Year", priority: 0.8 }
  );

  // Add genre-specific links
  if (context.genre) {
    links.push({
      url: `/${context.genre.toLowerCase()}`,
      text: `${context.genre} Games`,
      priority: 0.9,
    });
  }

  // Add developer links
  if (context.developer) {
    links.push({
      url: `/developer/${encodeURIComponent(context.developer)}`,
      text: `Games by ${context.developer}`,
      priority: 0.8,
    });
  }

  // Add publisher links
  if (context.publisher && context.publisher !== context.developer) {
    links.push({
      url: `/publisher/${encodeURIComponent(context.publisher)}`,
      text: `Games published by ${context.publisher}`,
      priority: 0.8,
    });
  }

  // Add year links
  if (context.year) {
    links.push({
      url: `/year/${context.year}`,
      text: `Games from ${context.year}`,
      priority: 0.8,
    });

    // Add adjacent years
    links.push(
      {
        url: `/year/${context.year - 1}`,
        text: `Games from ${context.year - 1}`,
        priority: 0.6,
      },
      {
        url: `/year/${context.year + 1}`,
        text: `Games from ${context.year + 1}`,
        priority: 0.6,
      }
    );
  }

  return links.sort((a, b) => b.priority - a.priority);
}

export function generateRelatedGameLinks(
  game: any
): Array<{ url: string; text: string }> {
  const links: Array<{ url: string; text: string }> = [];

  if (game.genre) {
    links.push({
      url: `/${game.genre.toLowerCase()}`,
      text: `More ${game.genre.toLowerCase()} games`,
    });
  }

  if (game.developer) {
    links.push({
      url: `/developer/${encodeURIComponent(game.developer)}`,
      text: `More games by ${game.developer}`,
    });
  }

  if (game.publisher && game.publisher !== game.developer) {
    links.push({
      url: `/publisher/${encodeURIComponent(game.publisher)}`,
      text: `More games published by ${game.publisher}`,
    });
  }

  if (game.release) {
    links.push({
      url: `/year/${game.release}`,
      text: `More games from ${game.release}`,
    });
  }

  return links;
}

export function generatePopularLinks(): Array<{ url: string; text: string }> {
  return [
    { url: "/?orderBy=rating&orderDir=DESC", text: "Top Rated Games" },
    { url: "/?orderBy=createdAt&orderDir=DESC", text: "Recently Added" },
    { url: "/adventure", text: "Adventure Games" },
    { url: "/action", text: "Action Games" },
    { url: "/strategy", text: "Strategy Games" },
    { url: "/year/1990", text: "Games from 1990" },
    { url: "/year/1995", text: "Games from 1995" },
  ];
}
