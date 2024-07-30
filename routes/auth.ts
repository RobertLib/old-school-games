import express from "express";
import { hashPassword, verifyPassword } from "../utils/password.ts";
import rateLimit from "express-rate-limit";
import User from "../models/user.ts";
import "../types/session.ts";

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  message: "Too many login attempts, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/login", async (req, res) => {
  res.render("auth/login");
});

router.post("/login", loginLimiter, async (req, res, next) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.render("auth/login", {
      error: "All fields are required.",
    });
  }

  const user = await User.findByEmail(email);

  if (!user) {
    return res.render("auth/login", {
      error: "Invalid credentials.",
    });
  }

  const valid = await verifyPassword(password, user.password);

  if (!valid) {
    return res.render("auth/login", {
      error: "Invalid credentials.",
    });
  }

  const userData = { id: user.id, email: user.email, role: user.role };

  req.session.regenerate((err) => {
    if (err) return next(err);

    req.session.user = userData;
    res.redirect("/");
  });
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/");
  });
});

/* router.get("/register", async (req, res) => {
  res.render("auth/register");
});

router.post("/register", async (req, res, next) => {
  try {
    const { email, password, confirmPassword } = req.body;

    if (!email || !password || !confirmPassword) {
      return res.render("auth/register", {
        error: "All fields are required.",
      });
    }

    if (!email.includes("@")) {
      return res.render("auth/register", {
        error: "Invalid email.",
      });
    }

    if (password.length < 6) {
      return res.render("auth/register", {
        error: "Password must be at least 6 characters long.",
      });
    }

    if (password !== confirmPassword) {
      return res.render("auth/register", {
        error: "Password and confirm password do not match.",
      });
    }

    const hash = await hashPassword(password);

    await User.create({ email, password: hash });

    res.redirect("/");
  } catch (error) {
    if (error.code === "23505") {
      return res.render("auth/register", {
        error: "User already exists.",
      });
    }

    next(error);
  }
}); */

export default router;
