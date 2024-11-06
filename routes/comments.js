import express from "express";
import Comment from "../models/comment.js";
import DOMPurify from "dompurify";
import { JSDOM } from "jsdom";

const window = new JSDOM("").window;
const purify = DOMPurify(window);

const router = express.Router();

router.post("/", async (req, res, next) => {
  const { nick, content, gameId } = req.body;

  const sanitizedNick = purify.sanitize(nick);
  const sanitizedContent = purify.sanitize(content);

  if (!sanitizedContent || !gameId) {
    return res.status(400).send("Invalid input");
  }

  if (sanitizedNick.length > 255) {
    return res.status(400).send("Nick is too long");
  }

  if (sanitizedContent.length > 1000) {
    return res.status(400).send("Content is too long");
  }

  const comment = await Comment.create({
    nick: sanitizedNick || "anonymous",
    content: sanitizedContent,
    gameId,
  });

  res.render("comments/comment-item", { comment });
});

export default router;
