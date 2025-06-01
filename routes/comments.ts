import express from "express";
import Comment from "../models/comment.ts";
import DOMPurify from "dompurify";
import rateLimit from "express-rate-limit";
import { JSDOM } from "jsdom";
import { validateComment } from "../validations/comments.ts";

const window = new JSDOM("").window;
const purify = DOMPurify(window);

const router = express.Router();

const commentRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  message: "Too many comments, please try again later.",
});

router.post("/", commentRateLimit, validateComment, async (req, res, next) => {
  const { nick, content, gameId } = req.body;

  const sanitizedNick = purify.sanitize(nick);
  const sanitizedContent = purify.sanitize(content);

  const comment = await Comment.create({
    nick: sanitizedNick || "anonymous",
    content: sanitizedContent,
    gameId,
  });

  res.render("comments/comment-item", { comment });
});

export default router;
