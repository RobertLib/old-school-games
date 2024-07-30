import { type Request, type Response, type NextFunction } from "express";
import Analytics from "../models/analytics.ts";

const BOT_PATTERNS = [
  /bot/i,
  /crawler/i,
  /spider/i,
  /crawling/i,
  /googlebot/i,
  /bingbot/i,
  /slurp/i,
  /duckduckbot/i,
  /baiduspider/i,
  /yandexbot/i,
  /facebookexternalhit/i,
  /twitterbot/i,
  /linkedinbot/i,
  /whatsapp/i,
  /telegrambot/i,
  /applebot/i,
  /amazonbot/i,
  /pingdom/i,
  /uptimerobot/i,
  /monitor/i,
  /curl/i,
  /wget/i,
  /python-requests/i,
  /axios/i,
  /postman/i,
  /httpie/i,
  /go-http-client/i,
  /java/i,
  /okhttp/i,
  /apache-httpclient/i,
];

function isBot(userAgent: string): boolean {
  if (!userAgent || userAgent.trim() === "") {
    return true;
  }

  return BOT_PATTERNS.some((pattern) => pattern.test(userAgent));
}

export default async function analytics(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const isGetRequest = req.method === "GET";
    const isStaticFile = req.path.match(
      /\.(css|js|png|jpg|jpeg|gif|ico|svg|webp|avif|heic)$/
    );

    const clientIP =
      (req.headers["x-forwarded-for"] as string) ||
      (req.headers["x-real-ip"] as string) ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      req.ip ||
      "";
    const realIP = clientIP.split(",")[0].trim();

    const isLocalhost =
      req.hostname === "localhost" ||
      req.hostname === "127.0.0.1" ||
      realIP === "127.0.0.1" ||
      realIP === "::1";

    const isAdmin = req.session?.user?.role === "ADMIN";
    const userAgent = req.get("User-Agent") || "";
    const isBotRequest = isBot(userAgent);

    const originalSend = res.send;
    res.send = function (body) {
      if (
        isGetRequest &&
        !isStaticFile &&
        !isLocalhost &&
        !isAdmin &&
        !isBotRequest &&
        res.statusCode >= 200 &&
        res.statusCode < 300
      ) {
        Analytics.logVisit({
          path: req.path,
          method: req.method,
          userAgent,
          ip: realIP,
          referer: req.get("Referer") || "",
          timestamp: new Date(),
        }).catch((error) => {
          console.error("Analytics error:", error);
        });
      }

      return originalSend.call(this, body);
    };
  } catch (error) {
    console.error("Analytics error:", error);
  }

  next();
}
