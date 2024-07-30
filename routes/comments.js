const express = require("express");
const router = express.Router();
const Comment = require("../models/comment");

router.post("/", async (req, res, next) => {
  try {
    const { content, gameId } = req.body;

    const comment = await Comment.create({ content, gameId });

    res.render("comments/comment-item", { comment });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
