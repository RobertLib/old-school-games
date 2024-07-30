import { beforeEach, describe, expect, it, vi } from "vitest";
import User from "../../models/user";
import db from "../../db";

vi.mock("../../db", () => ({
  default: {
    query: vi.fn(),
  },
}));

const mockDb = vi.mocked(db);

describe("User Model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("create", () => {
    it("should create a new user", async () => {
      const userData = {
        email: "test@example.com",
        password: "hashedpassword123",
      };

      const mockResult = {
        rows: [{ id: 1 }],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await User.create(userData);

      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "users" ("email", "password") VALUES ($1, $2) RETURNING "id"',
        [userData.email, userData.password]
      );
      expect(result).toEqual({ id: 1 });
    });
  });

  describe("findByEmail", () => {
    it("should find user by email", async () => {
      const mockUser = {
        id: 1,
        email: "test@example.com",
        password: "hashedpassword123",
        role: "user",
        created_at: new Date(),
        updated_at: new Date(),
        deleted_at: null,
      };

      (mockDb.query as any).mockResolvedValueOnce({ rows: [mockUser] });

      const result = await User.findByEmail("test@example.com");

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM "users" WHERE "email" = $1',
        ["test@example.com"]
      );
      expect(result).toBeInstanceOf(User);
      expect(result?.email).toBe("test@example.com");
      expect(result?.role).toBe("user");
    });

    it("should return null when user not found", async () => {
      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      const result = await User.findByEmail("nonexistent@example.com");

      expect(result).toBeNull();
    });

    it("should handle email search case sensitivity", async () => {
      const email = "Test@Example.COM";

      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await User.findByEmail(email);

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM "users" WHERE "email" = $1',
        [email]
      );
    });
  });

  describe("constructor", () => {
    it("should create a User instance with all properties", () => {
      const userData = {
        id: 1,
        email: "test@example.com",
        password: "hashedpassword123",
        role: "admin",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      const user = new User(userData);

      expect(user.id).toBe(userData.id);
      expect(user.email).toBe(userData.email);
      expect(user.password).toBe(userData.password);
      expect(user.role).toBe(userData.role);
      expect(user.createdAt).toBe(userData.createdAt);
      expect(user.updatedAt).toBe(userData.updatedAt);
      expect(user.deletedAt).toBe(userData.deletedAt);
    });

    it("should create a User instance without role", () => {
      const userData = {
        id: 1,
        email: "test@example.com",
        password: "hashedpassword123",
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      };

      const user = new User(userData);

      expect(user.role).toBeUndefined();
    });
  });
});
