import { type Request, type Response, type NextFunction } from "express";
import "../types/session.ts";

export function flash(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.flash) {
    req.session.flash = {};
  }

  req.flash = function (type?: string, message?: string): any {
    if (!req.session.flash) req.session.flash = {};

    if (type === undefined) {
      const messages = { ...req.session.flash };
      req.session.flash = {};
      return messages;
    }

    if (message !== undefined) {
      if (!req.session.flash[type]) req.session.flash[type] = [];
      req.session.flash[type].push(message);
      return;
    }

    const messages = req.session.flash[type] ?? [];
    delete req.session.flash[type];
    return messages;
  } as any;

  next();
}
