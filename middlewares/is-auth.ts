import { type Request, type Response, type NextFunction } from "express";
import "../types/session.ts";

export default function isAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (req.session?.user) {
    return next();
  }

  res.redirect("/login");
}
