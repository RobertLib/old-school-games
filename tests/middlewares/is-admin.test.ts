import { beforeEach, describe, expect, it, vi } from "vitest";
import isAdmin from "../../middlewares/is-admin";
import type { NextFunction } from "express";

describe("isAdmin Middleware", () => {
  const mockNext = vi.fn() as NextFunction;
  let mockReq: any;
  let mockRes: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRes = {
      status: vi.fn().mockReturnThis(),
      send: vi.fn(),
    };

    mockReq = {
      session: {},
    };
  });

  it("should call next() when user is admin", () => {
    mockReq.session = {
      user: {
        id: 1,
        email: "admin@test.com",
        role: "ADMIN",
      },
    };

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
    expect(mockRes.send).not.toHaveBeenCalled();
  });

  it("should return 403 when user is not admin", () => {
    mockReq.session = {
      user: {
        id: 1,
        email: "user@test.com",
        role: "USER",
      },
    };

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 403 when user has no role", () => {
    mockReq.session = {
      user: {
        id: 1,
        email: "user@test.com",
      },
    };

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 403 when user is null", () => {
    mockReq.session = {
      user: null,
    };

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 403 when user is undefined", () => {
    mockReq.session = {
      user: undefined,
    };

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 403 when session has no user property", () => {
    mockReq.session = {};

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 403 when session is undefined", () => {
    mockReq.session = undefined;

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 403 when role is different admin case", () => {
    mockReq.session = {
      user: {
        id: 1,
        email: "user@test.com",
        role: "admin",
      },
    };

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should return 403 when role is empty string", () => {
    mockReq.session = {
      user: {
        id: 1,
        email: "user@test.com",
        role: "",
      },
    };

    isAdmin(mockReq, mockRes, mockNext);

    expect(mockRes.status).toHaveBeenCalledWith(403);
    expect(mockRes.send).toHaveBeenCalledWith("Not authorized");
    expect(mockNext).not.toHaveBeenCalled();
  });
});
