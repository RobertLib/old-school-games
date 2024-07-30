import { type Request, type Response, type NextFunction } from "express";
import "../types/session.ts";

export default function isAdmin(
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (req.session?.user?.role === "ADMIN") {
    return next();
  }

  res.status(403).send("Not authorized");
}
