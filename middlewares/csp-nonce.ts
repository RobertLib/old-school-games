import crypto from "crypto";
import { type IncomingMessage, type ServerResponse } from "http";
import { type Request, type Response, type NextFunction } from "express";

/**
 * A fresh nonce per response, so the handful of inline <script> blocks the
 * views need can be allowed by name instead of by opening the door to every
 * inline script on the page.
 *
 * script-src used to carry 'unsafe-inline', which meant the Content-Security
 * -Policy offered no protection against injected script at all — it allows
 * exactly what an XSS payload needs. The escaping in the templates was the
 * only thing standing in the way.
 *
 * 'unsafe-eval' is no longer on the page policy at all, which is what this
 * note used to say it was. js-dos compiles and runs the DOS emulator at
 * runtime and cannot work without it, but only the emulator frame needs it —
 * so it moved to PLAYER_CSP in app.ts, the policy that replaces the header on
 * /js-dos.html alone. Everything else, including every page carrying a nonce
 * from here, is served without it: with 'unsafe-eval' an injected string
 * reaching any of the eval-alikes runs as this site and the nonce never enters
 * into it, so leaving it on the page policy undid a good part of what this
 * middleware buys.
 *
 * That split is a boundary only when the frame has an origin of its own. With
 * PLAYER_ORIGIN unset the frame is this site, and a same-origin frame allowed
 * scripts can reach its parent's DOM — this nonce included — or lift its own
 * sandbox, so whatever runs under PLAYER_CSP there runs as the page. See
 * PLAYER_ORIGIN in utils/site.ts and the frame in views/games/game-detail.ejs.
 */
export function cspNonce(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");

  next();
}

/**
 * Reads the nonce back for helmet's directive function, which is typed
 * against the bare node request and response rather than Express's.
 */
export function scriptNonce(
  req: IncomingMessage,
  res: ServerResponse,
): string {
  const { locals } = res as ServerResponse & {
    locals?: { cspNonce?: string };
  };

  return `'nonce-${locals?.cspNonce ?? ""}'`;
}
