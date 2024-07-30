import { beforeEach, describe, expect, it, vi } from "vitest";
import isAuth from "../../middlewares/is-auth";
import type { Request, Response, NextFunction } from "express";

describe("isAuth Middleware", () => {
  const mockNext = vi.fn() as NextFunction;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRes = {
      redirect: vi.fn(),
    };
  });

  it("should call next() when user is authenticated", () => {
    mockReq = {
      session: {
        user: { id: 1, email: "test@test.com" },
      },
    } as Partial<Request>;

    isAuth(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.redirect).not.toHaveBeenCalled();
  });

  it("should redirect to login when user is not authenticated", () => {
    mockReq = {
      session: {},
    } as Partial<Request>;

    isAuth(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.redirect).toHaveBeenCalledWith("/login");
    expect(mockNext).not.toHaveBeenCalled();
  });

  it("should redirect to login when session has no user", () => {
    mockReq = {
      session: {
        user: null,
      },
    } as unknown as Partial<Request>;

    isAuth(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.redirect).toHaveBeenCalledWith("/login");
    expect(mockNext).not.toHaveBeenCalled();
  });

  /**
   * No session at all, which is the case the optional chaining in the
   * middleware exists for — a request that never reached express-session,
   * because it was mounted below this guard or threw before it.
   *
   * This used to pass `session: {}` and was therefore a second copy of the
   * "not authenticated" case above: it exercised `req.session.user` being
   * undefined, never `req.session` itself. Reading `.user` off undefined
   * throws, and a thrown TypeError here is a 500 on a page that should simply
   * have sent the visitor to the login form.
   */
  it("should redirect to login when session is undefined", () => {
    mockReq = {} as Partial<Request>;

    isAuth(mockReq as Request, mockRes as Response, mockNext);

    expect(mockRes.redirect).toHaveBeenCalledWith("/login");
    expect(mockNext).not.toHaveBeenCalled();
  });
});
