import { beforeEach, describe, expect, it, vi } from "vitest";
import isAdmin from "../../middlewares/is-admin";
import User from "../../models/user";
import type { NextFunction } from "express";

vi.mock("../../models/user", () => ({
  default: { findById: vi.fn() },
}));

const mockUser = vi.mocked(User);

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
      mockReq.session = {
        user: { id: 1, email: "admin@test.com", role: "ADMIN" },
      };
      mockUser.findById.mockResolvedValue({ id: 1, role: "ADMIN" } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockUser.findById).toHaveBeenCalledWith(1);
      expect(mockNext).toHaveBeenCalledWith();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("refuses a session that still claims ADMIN after a demotion", async () => {
      mockReq.session = {
        user: { id: 1, email: "admin@test.com", role: "ADMIN" },
      };
      mockUser.findById.mockResolvedValue({ id: 1, role: "USER" } as any);

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
      mockReq.session = {
        user: { id: 1, email: "admin@test.com", role: "ADMIN" },
      };
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

      mockReq.session = {
        user: { id: 1, email: "admin@test.com", role: "ADMIN" },
      };
      mockUser.findById.mockRejectedValue(error);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalledWith(error);
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("refuses a lower-cased stored role", async () => {
      mockReq.session = {
        user: { id: 1, email: "admin@test.com", role: "ADMIN" },
      };
      mockUser.findById.mockResolvedValue({ id: 1, role: "admin" } as any);

      await isAdmin(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
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
