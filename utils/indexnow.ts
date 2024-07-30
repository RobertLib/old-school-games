import winston from "winston";

const logger = winston.createLogger({
  level: "info",
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: "error.log", level: "error" }),
    new winston.transports.File({ filename: "combined.log" }),
  ],
});

interface IndexNowResponse {
  success: boolean;
  error?: string;
}

export default class IndexNow {
  private static readonly INDEXNOW_URL = "https://api.indexnow.org/indexnow";

  private static get INDEXNOW_KEY(): string | undefined {
    return process.env.INDEXNOW_KEY;
  }

  private static get SITE_URL(): string {
    return process.env.SITE_URL || "https://oldschoolgames.eu";
  }

  /**
   * Submit URLs to IndexNow API
   * @param urls Array of URLs to submit
   * @returns Promise<IndexNowResponse>
   */
  static async submitUrls(urls: string[]): Promise<IndexNowResponse> {
    if (!this.INDEXNOW_KEY) {
      logger.warn("IndexNow: API key not configured");
      return { success: false, error: "API key not configured" };
    }

    if (!urls.length) {
      return { success: true };
    }

    // Convert relative URLs to absolute URLs
    const absoluteUrls = urls.map((url) => {
      if (url.startsWith("http")) {
        return url;
      }
      return url.startsWith("/")
        ? `${this.SITE_URL}${url}`
        : `${this.SITE_URL}/${url}`;
    });

    try {
      const payload = {
        host: new URL(this.SITE_URL).hostname,
        key: this.INDEXNOW_KEY,
        urlList: absoluteUrls,
      };

      logger.info(`IndexNow: Submitting ${absoluteUrls.length} URLs`, {
        urls: absoluteUrls,
      });

      const response = await fetch(this.INDEXNOW_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        logger.info("IndexNow: URLs submitted successfully", {
          status: response.status,
          urls: absoluteUrls,
        });
        return { success: true };
      } else {
        const errorText = await response.text();
        logger.error("IndexNow: Failed to submit URLs", {
          status: response.status,
          error: errorText,
          urls: absoluteUrls,
        });
        return {
          success: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }
    } catch (error) {
      logger.error("IndexNow: Request failed", {
        error: error.message,
        urls: absoluteUrls,
      });
      return { success: false, error: error.message };
    }
  }

  /**
   * Submit a single URL to IndexNow
   * @param url URL to submit
   * @returns Promise<IndexNowResponse>
   */
  static async submitUrl(url: string): Promise<IndexNowResponse> {
    return this.submitUrls([url]);
  }

  /**
   * Submit game-related URLs when a game is created or updated
   * @param gameSlug Game slug
   * @param gameGenre Game genre
   * @param gameDeveloper Game developer (optional)
   * @param gamePublisher Game publisher (optional)
   * @param gameYear Game release year (optional)
   * @returns Promise<IndexNowResponse>
   */
  static async submitGameUrls(
    gameSlug: string,
    gameGenre?: string,
    gameDeveloper?: string,
    gamePublisher?: string,
    gameYear?: number
  ): Promise<IndexNowResponse> {
    const urls = [
      `/${gameSlug}`, // Game detail page
      "/", // Homepage (recent games)
    ];

    // Add genre page
    if (gameGenre) {
      urls.push(`/${gameGenre.toLowerCase()}`);
    }

    // Add developer page
    if (gameDeveloper) {
      urls.push(`/developer/${encodeURIComponent(gameDeveloper)}`);
    }

    // Add publisher page
    if (gamePublisher) {
      urls.push(`/publisher/${encodeURIComponent(gamePublisher)}`);
    }

    // Add year page
    if (gameYear) {
      urls.push(`/year/${gameYear}`);
    }

    // Add alphabet letter page
    if (gameSlug) {
      const firstLetter = gameSlug.charAt(0).toLowerCase();
      if (/[a-z]/.test(firstLetter)) {
        urls.push(`/letter/${firstLetter}`);
      }
    }

    // Add sitemap
    urls.push("/sitemap-index.xml");

    return this.submitUrls(urls);
  }

  /**
   * Submit URLs when a game is deleted
   * @param gameSlug Game slug that was deleted
   * @returns Promise<IndexNowResponse>
   */
  static async submitGameDeletedUrls(
    gameSlug: string
  ): Promise<IndexNowResponse> {
    const urls = [
      "/", // Homepage
      "/sitemap-index.xml", // Sitemap
    ];

    return this.submitUrls(urls);
  }
}
