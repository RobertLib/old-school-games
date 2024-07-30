import { beforeEach, describe, expect, it, vi } from "vitest";
import isAdmin from "../../middlewares/is-admin";
import User from "../../models/user";
import { credentialOf } from "../../utils/session-credential";
import { SESSION_COOKIE } from "../../utils/session-cookie";
import type { NextFunction } from "express";

vi.mock("../../models/user", () => ({
  default: { findById: vi.fn() },
}));

const mockUser = vi.mocked(User);

/** The stored hash the account rows below carry, and a reset's replacement. */
const HASH = "scrypt$16384$8$5$aaaa$bbbb";
const RESET_HASH = "scrypt$16384$8$5$cccc$dddd";

/** A signed-in session as the login writes it: opened under HASH. */
function adminSession(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      id: 1,
      email: "admin@test.com",
      role: "ADMIN",
      credential: credentialOf(HASH),
      ...overrides,
    },
  };
}

describe("isAdmin Middleware", () => {
  const mockNext = vi.fn() as NextFunction;
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRes = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
      render: vi.fn(),
      redirect: vi.fn(),
      clearCookie: vi.fn(),
    };

    mockReq = {
      session: {},
    };
  });

  /**
   * The role is read from the database rather than from the session, so
   * revoking admin rights takes effect on the next request instead of when
   * the cookie happens to expire — up to thirty days later.
   */
  describe("the role comes from the database, not the session", () => {
    it("calls next() when the stored role is ADMIN", async () => {
      mockReq.session = adminSession();
      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "ADMIN",
        password: HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockUser.findById).toHaveBeenCalledWith(1);
      expect(mockNext).toHaveBeenCalledWith();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("refuses a session that still claims ADMIN after a demotion", async () => {
      mockReq.session = adminSession();
      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "USER",
        password: HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.render).toHaveBeenCalledWith("403", {
        // The refusal is a page that asks not to be indexed: views/head.ejs
        // turns this into the one robots tag on it and drops the canonical
        // that would otherwise name the refused address.
        noindex: true,
        message: expect.any(String),
      });
      expect(mockRes.send).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("refuses a session whose account has been deleted", async () => {
      mockReq.session = adminSession();
      mockUser.findById.mockResolvedValue(null);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.render).toHaveBeenCalledWith("403", {
        // The refusal is a page that asks not to be indexed: views/head.ejs
        // turns this into the one robots tag on it and drops the canonical
        // that would otherwise name the refused address.
        noindex: true,
        message: expect.any(String),
      });
      expect(mockRes.send).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it("hands a failed lookup to the error handler rather than authorizing", async () => {
      const error = new Error("connection terminated");

      mockReq.session = adminSession();
      mockUser.findById.mockRejectedValue(error);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("refuses a lower-cased stored role", async () => {
      mockReq.session = adminSession();
      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "admin",
        password: HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  /**
   * The session also carries the credential it was opened with, and a reset
   * replaces the account's hash — so a session from before the reset stops
   * matching here, whatever became of its row. The role alone could not do
   * this: a reset leaves it ADMIN, and the role is all this used to compare.
   * tests/session-revocation.test.ts drives the same thing through the real
   * store and a real reset.
   */
  describe("the credential the session was opened with", () => {
    /** A session the store would destroy, remembering that it was asked. */
    function destroyableSession(session: Record<string, unknown>) {
      const destroy = vi.fn((callback: (error?: unknown) => void) => {
        callback();
      });

      mockReq.session = { ...session, destroy };

      return destroy;
    }

    function expectSignedOut(destroy: ReturnType<typeof vi.fn>) {
      // Ended rather than refused: the row goes, the cookie is cleared with
      // the attributes it was set with, and the browser is sent to sign in.
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        SESSION_COOKIE,
        expect.objectContaining({ path: "/", httpOnly: true }),
      );
      expect(mockRes.redirect).toHaveBeenCalledWith("/login");
      expect(mockRes.status).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    }

    it("signs out a session opened before the password was reset", async () => {
      const destroy = destroyableSession(adminSession());

      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "ADMIN",
        password: RESET_HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expectSignedOut(destroy);
    });

    // Every session written before sessions carried a credential — which is
    // every one in production on the day this shipped. Nothing tells it
    // apart from one that outlived a reset.
    it("signs out a session that carries no credential", async () => {
      const destroy = destroyableSession(
        adminSession({ credential: undefined }),
      );

      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "ADMIN",
        password: HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expectSignedOut(destroy);
    });

    it("signs out a session whose credential is not a string", async () => {
      const destroy = destroyableSession(adminSession({ credential: 42 }));

      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "ADMIN",
        password: HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expectSignedOut(destroy);
    });

    // A revoked session is revoked whatever its account's role is now, so it
    // is ended rather than shown the 403 a demotion gets.
    it("asks about the credential before the role", async () => {
      const destroy = destroyableSession(adminSession());

      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "USER",
        password: RESET_HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expectSignedOut(destroy);
    });

    // The session is still ended as far as the browser goes, as the logout
    // does: a store that failed to delete the row is logged, not a 500 that
    // skips clearing the cookie.
    it("still clears the cookie when the store cannot delete the row", async () => {
      mockReq.session = {
        ...adminSession(),
        destroy: vi.fn((callback: (error?: unknown) => void) => {
          callback(new Error("store down"));
        }),
      };
      mockUser.findById.mockResolvedValue({
        id: 1,
        role: "ADMIN",
        password: RESET_HASH,
      } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockRes.clearCookie).toHaveBeenCalled();
      expect(mockRes.redirect).toHaveBeenCalledWith("/login");
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  /**
   * No session means no lookup: there is nothing to look up, and the request
   * should not cost a query to be turned away.
   */
  describe("without a signed-in user", () => {
    it.each([
      ["user is null", { user: null }],
      ["user is undefined", { user: undefined }],
      ["session has no user property", {}],
      ["session is undefined", undefined],
    ])("returns 403 when %s", async (_label, session) => {
      mockReq.session = session;

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.render).toHaveBeenCalledWith("403", {
        // The refusal is a page that asks not to be indexed: views/head.ejs
        // turns this into the one robots tag on it and drops the canonical
        // that would otherwise name the refused address.
        noindex: true,
        message: expect.any(String),
      });
      expect(mockRes.send).not.toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
      expect(mockUser.findById).not.toHaveBeenCalled();
    });
  });
});
