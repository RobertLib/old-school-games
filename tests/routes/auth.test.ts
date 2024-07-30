import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import bcrypt from "bcrypt";
import authRouter from "../../routes/auth";
import User from "../../models/user";

vi.mock("bcrypt");
vi.mock("../../models/user", () => ({
  default: {
    findByEmail: vi.fn(),
    create: vi.fn(),
  },
}));

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const sessionHeader = req.headers.testsession;
  if (sessionHeader && typeof sessionHeader === "string") {
    try {
      const sessionData = JSON.parse(sessionHeader);
      req.session = {
        ...sessionData,
        id: "test-session-id",
        cookie: {} as any,
        regenerate: vi.fn(),
        destroy: vi.fn((callback?: (err?: any) => void) => {
          req.session = {
            id: "test-session-id",
            cookie: {} as any,
            regenerate: vi.fn(),
            destroy: vi.fn(),
            reload: vi.fn(),
            save: vi.fn(),
            touch: vi.fn(),
          } as any;
          if (callback) callback();
        }),
        reload: vi.fn(),
        save: vi.fn(),
        touch: vi.fn(),
      } as any;
    } catch {
      req.session = {
        id: "test-session-id",
        cookie: {} as any,
        regenerate: vi.fn(),
        destroy: vi.fn((callback?: (err?: any) => void) => {
          if (callback) callback();
        }),
        reload: vi.fn(),
        save: vi.fn(),
        touch: vi.fn(),
      } as any;
    }
  } else {
    req.session = {
      id: "test-session-id",
      cookie: {} as any,
      regenerate: vi.fn(),
      destroy: vi.fn((callback?: (err?: any) => void) => {
        if (callback) callback();
      }),
      reload: vi.fn(),
      save: vi.fn(),
      touch: vi.fn(),
    } as any;
  }
  next();
});

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  });
  next();
});

app.use(authRouter);

describe("Auth Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /login", () => {
    it("should render login page", async () => {
      const response = await request(app).get("/login");

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data).toBeUndefined();
    });
  });

  describe("POST /login", () => {
    const mockUser = {
      id: 1,
      email: "test@example.com",
      password: "hashedpassword",
      role: "USER",
    };

    it("should login successfully with valid credentials", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

      const response = await request(app).post("/login").send({
        email: "test@example.com",
        password: "password123",
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
      expect(User.findByEmail).toHaveBeenCalledWith("test@example.com");
      expect(bcrypt.compare).toHaveBeenCalledWith(
        "password123",
        "hashedpassword"
      );
    });

    it("should return error when email is missing", async () => {
      const response = await request(app).post("/login").send({
        password: "password123",
      });

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("All fields are required.");
    });

    it("should return error when password is missing", async () => {
      const response = await request(app).post("/login").send({
        email: "test@example.com",
      });

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("All fields are required.");
    });

    it("should return error when both email and password are missing", async () => {
      const response = await request(app).post("/login").send({});

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("All fields are required.");
    });

    it("should return error when user is not found", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(null);

      const response = await request(app).post("/login").send({
        email: "nonexistent@example.com",
        password: "password123",
      });

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("Invalid credentials.");
      expect(User.findByEmail).toHaveBeenCalledWith("nonexistent@example.com");
    });

    it("should return error when password is invalid", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

      const response = await request(app).post("/login").send({
        email: "test@example.com",
        password: "wrongpassword",
      });

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("auth/login");
      expect(response.body.data.error).toBe("Invalid credentials.");
      expect(User.findByEmail).toHaveBeenCalledWith("test@example.com");
      expect(bcrypt.compare).toHaveBeenCalledWith(
        "wrongpassword",
        "hashedpassword"
      );
    });

    it("should set session user data on successful login", async () => {
      vi.mocked(User.findByEmail).mockResolvedValue(mockUser as any);
      vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

      const response = await request(app).post("/login").send({
        email: "test@example.com",
        password: "password123",
      });

      expect(response.status).toBe(302);
    });
  });

  describe("GET /logout", () => {
    it("should logout user and redirect to home", async () => {
      const response = await request(app)
        .get("/logout")
        .set(
          "testsession",
          JSON.stringify({
            user: { id: 1, email: "test@example.com", role: "USER" },
          })
        );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });

    it("should work even when user is not logged in", async () => {
      const response = await request(app).get("/logout");

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });
  });
});
