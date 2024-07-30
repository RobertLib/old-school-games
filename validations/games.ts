import { type Request, type Response, type NextFunction } from "express";

export const validateGameRating = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const { id } = req.params;
  const { rating } = req.body;

  const gameId = parseInt(id, 10);
  if (isNaN(gameId) || gameId <= 0) {
    res.status(400).json({ error: "Invalid game ID" });
    return;
  }

  const numericRating = parseInt(rating, 10);
  if (!numericRating || numericRating < 1 || numericRating > 5) {
    res.status(400).json({ error: "Rating must be between 1 and 5" });
    return;
  }

  next();
};
