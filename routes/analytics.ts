import express from "express";
import isAuth from "../middlewares/is-auth.ts";
import isAdmin from "../middlewares/is-admin.ts";
import Analytics from "../models/analytics.ts";

const router = express.Router();

router.get("/analytics", isAuth, isAdmin, async (req, res) => {
  const days = parseInt(req.query.days as string) || 30;

  const [pageStats, dailyStats, totalStats, topReferers] = await Promise.all([
    Analytics.getPageStats(days),
    Analytics.getDailyStats(days),
    Analytics.getTotalStats(days),
    Analytics.getTopReferers(days),
  ]);

  res.render("analytics/dashboard", {
    pageStats,
    dailyStats,
    totalStats,
    topReferers,
    days,
    title: "Analytics Dashboard - OldSchoolGames",
  });
});

export default router;
