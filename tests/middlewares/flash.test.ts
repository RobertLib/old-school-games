import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";
import { flash } from "../../middlewares/flash.ts";

function makeReq(session: Record<string, unknown> = {}): Request {
  return { session } as unknown as Request;
}

describe("flash", () => {
  let next: NextFunction;

  beforeEach(() => {
    next = vi.fn();
  });

  it("installs req.flash and continues", () => {
    const req = makeReq();

    flash(req, {} as Response, next);

    expect(typeof req.flash).toBe("function");
    expect(next).toHaveBeenCalled();
  });

  // Pre-creating the container counted as modifying the session on every
  // request, so a row was written and a cookie set for every crawler.
  it("leaves the session untouched when nothing is read or stored", () => {
    const session = {};
    const req = makeReq(session);

    flash(req, {} as Response, next);

    expect(session).toEqual({});
  });

  it("leaves the session untouched when reading from an empty one", () => {
    const session = {};
    const req = makeReq(session);

    flash(req, {} as Response, next);

    expect(req.flash()).toEqual({});
    expect(req.flash("info")).toEqual([]);
    expect(session).toEqual({});
  });

  it("stores a message under its type", () => {
    const session: Record<string, any> = {};
    const req = makeReq(session);

    flash(req, {} as Response, next);
    req.flash("info", "Saved");
    req.flash("info", "And again");
    req.flash("error", "Nope");

    expect(session.flash).toEqual({
      info: ["Saved", "And again"],
      error: ["Nope"],
    });
  });

  it("returns and clears a single type", () => {
    const session: Record<string, any> = {};
    const req = makeReq(session);

    flash(req, {} as Response, next);
    req.flash("info", "Saved");

    expect(req.flash("info")).toEqual(["Saved"]);
    expect(req.flash("info")).toEqual([]);
    expect(session.flash).toEqual({});
  });

  it("returns and clears everything at once", () => {
    const session: Record<string, any> = {};
    const req = makeReq(session);

    flash(req, {} as Response, next);
    req.flash("info", "Saved");
    req.flash("error", "Nope");

    expect(req.flash()).toEqual({ info: ["Saved"], error: ["Nope"] });
    expect(req.flash()).toEqual({});
  });

  it("survives a session that already carries messages", () => {
    const session = { flash: { info: ["From the last request"] } };
    const req = makeReq(session);

    flash(req, {} as Response, next);

    expect(req.flash("info")).toEqual(["From the last request"]);
  });
});
