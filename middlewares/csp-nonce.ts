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
 * 'unsafe-eval' stays: js-dos compiles and runs the DOS emulator at runtime
 * and does not work without it. That is a much narrower hole than
 * 'unsafe-inline' — it cannot be reached by injecting markup.
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
