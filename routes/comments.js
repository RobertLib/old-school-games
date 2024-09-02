import express from "express";
import Comment from "../models/comment.js";

const router = express.Router();

router.post("/", async (req, res, next) => {
  const comment = await Comment.create(req.body);

  res.render("comments/comment-item", { comment });
});

export default router;
