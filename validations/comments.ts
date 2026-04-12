import { type Request, type Response, type NextFunction } from "express";

export const validateComment = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const { nick, content, gameId } = req.body;

  const referer = req.get("Referer") || "/";
  const safeRedirect = (() => {
    try {
      return new URL(referer, "http://localhost").pathname;
    } catch {
      return "/";
    }
  })();

  if (nick && nick.length > 255) {
    req.flash("error", "Nick is too long");
    return res.redirect(safeRedirect);
  }

  if (!content || content.trim().length === 0) {
    req.flash("error", "Content is required");
    return res.redirect(safeRedirect);
  }

  if (content.length > 1000) {
    req.flash("error", "Content is too long");
    return res.redirect(safeRedirect);
  }

  if (content && /<script|javascript:|data:/i.test(content)) {
    req.flash("error", "Invalid content detected");
    return res.redirect(safeRedirect);
  }

  const numericGameId = parseInt(gameId, 10);
  if (
    isNaN(numericGameId) ||
    numericGameId <= 0 ||
    numericGameId > Number.MAX_SAFE_INTEGER
  ) {
    req.flash("error", "Invalid game ID");
    return res.redirect(safeRedirect);
  }

  next();
};
