export default function isAdmin(req, res, next) {
  if (req.session.user?.role === "ADMIN") {
    return next();
  }

  res.status(403).send("Not authorized");
}
