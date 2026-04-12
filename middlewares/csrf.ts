import crypto from "crypto";
import { type Request, type Response, type NextFunction } from "express";
import "../types/session.ts";

export function csrfToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

export function validateCsrf(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    return next();
  }

  const token =
    (req.body as Record<string, string> | undefined)?._csrf ||
    req.headers["x-csrf-token"];

  if (!token || token !== req.session.csrfToken) {
    res.status(403).send("Invalid CSRF token");
    return;
  }

  next();
}
