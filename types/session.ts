import "express-session";

declare module "express-session" {
  interface Session {
    user?: {
      id: number;
      email: string;
      role?: string;
    };
    flash?: Record<string, string[]>;
  }
}

declare global {
  namespace Express {
    interface Request {
      flash(): Record<string, string[]>;
      flash(type: string): string[];
      flash(type: string, message: string): void;
      /** Anonymous per-browser id used to deduplicate ratings. */
      voterId?: string;
      /** Double-submit CSRF token carried by this browser's cookie. */
      csrfToken?: string;
    }
  }
}
