import express from "express";
import Comment from "../models/comment.ts";
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
    res.status(400).send("Invalid input");
    return;
  }

  if (sanitizedNick.length > 255) {
    res.status(400).send("Nick is too long");
    return;
  }

  if (sanitizedContent.length > 1000) {
    res.status(400).send("Content is too long");
    return;
  }

  const comment = await Comment.create({
    nick: sanitizedNick || "anonymous",
    content: sanitizedContent,
    gameId,
  });

  res.render("comments/comment-item", { comment });
});

export default router;
