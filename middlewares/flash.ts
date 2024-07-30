import { type Request, type Response, type NextFunction } from "express";
import "../types/session.ts";

/**
 * A browser follows a 302 as soon as its headers arrive. express-session's
 * automatic save sends those headers before the asynchronous store write has
 * finished, so the next page can read the old session and miss its message.
 * Save first, just as the login does; a failed save reaches the error handler
 * instead of redirecting to a page whose feedback was never persisted.
 */
export async function redirectWithFlash(
  req: Request,
  res: Response,
  url: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  res.redirect(url);
}

/**
 * One-shot messages carried across a redirect.
 *
 * Nothing here touches the session until a message is actually stored.
 * Creating the container up front counted as modifying the session on every
 * single request, so express-session wrote a row — and set a cookie — for
 * every anonymous visitor and every crawler that would never see a message.
 */
export function flash(req: Request, res: Response, next: NextFunction): void {
  req.flash = function (type?: string, message?: string): any {
    if (type !== undefined && message !== undefined) {
      if (!req.session.flash) req.session.flash = {};
      if (!req.session.flash[type]) req.session.flash[type] = [];

      req.session.flash[type].push(message);
      return;
    }

    // Reading when nothing was ever stored: answer without writing.
    if (!req.session.flash) {
      return type === undefined ? {} : [];
    }

    if (type === undefined) {
      const messages = { ...req.session.flash };
      req.session.flash = {};
      return messages;
    }

    const messages = req.session.flash[type] ?? [];
    delete req.session.flash[type];
    return messages;
  } as any;

  next();
}
