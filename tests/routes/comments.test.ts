import { beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";
import commentsRouter from "../../routes/comments";
import Comment from "../../models/comment";

vi.mock("../../models/comment", () => ({
  default: {
    create: vi.fn(),
    findByGameId: vi.fn(),
  },
}));

vi.mock("dompurify", () => ({
  default: () => ({
    sanitize: vi.fn((content: string) => content),
  }),
}));

vi.mock("jsdom", () => ({
  JSDOM: vi.fn(() => ({
    window: {},
  })),
}));

vi.mock("../../validations/comments", () => ({
  validateComment: (req: any, res: any, next: any) => {
    const { nick, content, gameId } = req.body;

    if (nick && nick.length > 255) {
      req.flash("error", "Nick is too long");
      return res.redirect(req.get("Referer") || "/");
    }

    if (!content || content.trim().length === 0) {
      req.flash("error", "Content is required");
      return res.redirect(req.get("Referer") || "/");
    }

    if (content.length > 1000) {
      req.flash("error", "Content is too long");
      return res.redirect(req.get("Referer") || "/");
    }

    const numericGameId = parseInt(gameId, 10);
    if (isNaN(numericGameId) || numericGameId <= 0) {
      req.flash("error", "Invalid game ID");
      return res.redirect(req.get("Referer") || "/");
    }

    next();
  },
}));

vi.mock("express-rate-limit", () => ({
  default: () => (req: any, res: any, next: any) => next(),
}));

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  req.flash = vi.fn((type: string, message: string) => {
    (req as any).flashMessages = (req as any).flashMessages || {};
    if (!(req as any).flashMessages[type]) {
      (req as any).flashMessages[type] = [];
    }
    (req as any).flashMessages[type].push(message);
  }) as any;
  next();
});

app.use((req, res, next) => {
  res.render = vi.fn((view, data) => {
    res.json({ view, data });
  });
  next();
});

app.use((req, res, next) => {
  req.get = vi.fn((header: string) => {
    if (header === "Referer") {
      return (req.headers.referer as string) || null;
    }
    return req.headers[header.toLowerCase()] as string;
  }) as any;
  next();
});

app.use(commentsRouter);

describe("Comments Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("POST /", () => {
    const mockComment = {
      id: 1,
      nick: "TestUser",
      content: "This is a test comment",
      gameId: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      vi.mocked(Comment.create).mockResolvedValue(mockComment as any);
    });

    it("should create a comment successfully with valid data", async () => {
      const response = await request(app).post("/").send({
        nick: "TestUser",
        content: "This is a test comment",
        gameId: "1",
      });

      expect(response.status).toBe(200);
      expect(response.body.view).toBe("comments/comment-item");
      expect(response.body.data.comment).toMatchObject({
        id: 1,
        nick: "TestUser",
        content: "This is a test comment",
        gameId: 1,
      });
      expect(Comment.create).toHaveBeenCalledWith({
        nick: "TestUser",
        content: "This is a test comment",
        gameId: "1",
      });
    });

    it("should redirect when nick is too long", async () => {
      const longNick = "a".repeat(256);

      const response = await request(app)
        .post("/")
        .set("referer", "/games/1")
        .send({
          nick: longNick,
          content: "This is a test comment",
          gameId: "1",
        });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");
    });

    it("should redirect when content is empty", async () => {
      const response = await request(app)
        .post("/")
        .set("referer", "/games/1")
        .send({
          nick: "TestUser",
          content: "",
          gameId: "1",
        });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");
    });

    it("should redirect when content is too long", async () => {
      const longContent = "a".repeat(1001);

      const response = await request(app)
        .post("/")
        .set("referer", "/games/1")
        .send({
          nick: "TestUser",
          content: longContent,
          gameId: "1",
        });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");
    });

    it("should redirect when gameId is invalid (not a number)", async () => {
      const response = await request(app)
        .post("/")
        .set("referer", "/games/1")
        .send({
          nick: "TestUser",
          content: "This is a test comment",
          gameId: "invalid",
        });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");
    });

    it("should redirect when gameId is negative", async () => {
      const response = await request(app)
        .post("/")
        .set("referer", "/games/1")
        .send({
          nick: "TestUser",
          content: "This is a test comment",
          gameId: "-1",
        });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");
    });

    it("should redirect when gameId is zero", async () => {
      const response = await request(app)
        .post("/")
        .set("referer", "/games/1")
        .send({
          nick: "TestUser",
          content: "This is a test comment",
          gameId: "0",
        });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/games/1");
    });

    it("should redirect to home when no referer is provided and validation fails", async () => {
      const response = await request(app).post("/").send({
        nick: "TestUser",
        content: "",
        gameId: "1",
      });

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/");
    });

    it("should handle Comment.create errors", async () => {
      vi.mocked(Comment.create).mockRejectedValue(new Error("Database error"));

      const response = await request(app).post("/").send({
        nick: "TestUser",
        content: "This is a test comment",
        gameId: "1",
      });

      expect(response.status).toBe(500);
    });

    it("should create comment with nick provided", async () => {
      const response = await request(app).post("/").send({
        nick: "TestUser",
        content: "This is a test comment",
        gameId: "1",
      });

      expect(response.status).toBe(200);
      expect(Comment.create).toHaveBeenCalledWith({
        nick: "TestUser",
        content: "This is a test comment",
        gameId: "1",
      });
    });

    it("should create comment without nick (anonymous)", async () => {
      const response = await request(app).post("/").send({
        content: "This is a test comment",
        gameId: "1",
      });

      expect(response.status).toBe(200);
      expect(Comment.create).toHaveBeenCalledWith({
        nick: "anonymous",
        content: "This is a test comment",
        gameId: "1",
      });
    });
  });
});
