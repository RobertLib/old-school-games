import { beforeEach, describe, expect, it, vi } from "vitest";
import User from "../../models/user";
import db from "../../db";
import { verifyPassword } from "../../utils/password";

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
        password: "correct horse battery staple",
      };

      const mockResult = {
        rows: [{ id: 1 }],
      };

      (mockDb.query as any).mockResolvedValueOnce(mockResult);

      const result = await User.create(userData);

      expect(mockDb.query).toHaveBeenCalledWith(
        'INSERT INTO "users" ("email", "password") VALUES ($1, $2) RETURNING "id"',
        [userData.email, expect.any(String)],
      );
      expect(result).toEqual({ id: 1 });
    });

    // The point of the assertions below: create() used to store whatever it
    // was handed, so seeding an account the obvious way wrote a plaintext
    // password that verifyPassword would then refuse.
    it("stores a hash rather than the password it was given", async () => {
      const password = "correct horse battery staple";

      (mockDb.query as any).mockResolvedValueOnce({ rows: [{ id: 1 }] });

      await User.create({ email: "test@example.com", password });

      const [, values] = (mockDb.query as any).mock.calls[0];
      const stored = values[1];

      expect(stored).not.toBe(password);
      expect(stored).not.toContain(password);
      // The current format carries the cost it was derived at — see PREFIX in
      // utils/password.ts.
      expect(stored.startsWith("scrypt$")).toBe(true);
      // And it is the password's hash, not merely something that is not the
      // password.
      await expect(verifyPassword(password, stored)).resolves.toBe(true);
      await expect(verifyPassword("wrong", stored)).resolves.toBe(false);
    });

    it("gives two accounts with the same password different hashes", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 1 }] })
        .mockResolvedValueOnce({ rows: [{ id: 2 }] });

      await User.create({ email: "a@example.com", password: "same-password" });
      await User.create({ email: "b@example.com", password: "same-password" });

      const [, first] = (mockDb.query as any).mock.calls[0];
      const [, second] = (mockDb.query as any).mock.calls[1];

      expect(first[1]).not.toBe(second[1]);
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
        'SELECT * FROM "users" WHERE LOWER("email") = LOWER($1)',
        ["test@example.com"],
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

    it("looks an address up regardless of how it was capitalised", async () => {
      const email = "Test@Example.COM";

      (mockDb.query as any).mockResolvedValueOnce({ rows: [] });

      await User.findByEmail(email);

      expect(mockDb.query).toHaveBeenCalledWith(
        'SELECT * FROM "users" WHERE LOWER("email") = LOWER($1)',
        [email],
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

  describe("upsertAdmin", () => {
    it("writes the role, which create() cannot", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ id: 1, created: true }],
      });

      await User.upsertAdmin({
        email: "admin@example.com",
        password: "correct horse battery staple",
      });

      const [sql] = (mockDb.query as any).mock.calls[0];

      // The whole reason this method exists: create() inserts email and
      // password only, so "role" took its DEFAULT of 'USER' and no code path
      // anywhere could produce an admin.
      expect(sql).toContain(`'ADMIN'`);
      expect(sql).toContain('"role"');
    });

    it("stores a hash verifyPassword accepts, not the password", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ id: 1, created: true }],
      });

      const password = "correct horse battery staple";

      await User.upsertAdmin({ email: "admin@example.com", password });

      const [, values] = (mockDb.query as any).mock.calls[0];

      expect(values[1]).not.toBe(password);
      expect(await verifyPassword(password, values[1])).toBe(true);
    });

    it("matches an existing account whatever case it was stored in", async () => {
      (mockDb.query as any).mockResolvedValueOnce({
        rows: [{ id: 1, created: false }],
      });

      await User.upsertAdmin({
        email: "Admin@Example.com",
        password: "correct horse battery staple",
      });

      const [sql] = (mockDb.query as any).mock.calls[0];

      // The arbiter has to be the functional index from
      // 0025_users_email_case_insensitive.sql, or "Admin@Example.com" would
      // fail the plain UNIQUE on the column instead of finding the row
      // already stored as "admin@example.com".
      expect(sql).toContain('ON CONFLICT (LOWER("email")) DO UPDATE');
    });

    it("reports whether it created the account or promoted one", async () => {
      (mockDb.query as any)
        .mockResolvedValueOnce({ rows: [{ id: 7, created: true }] })
        .mockResolvedValueOnce({ rows: [{ id: 7, created: false }] });

      const first = await User.upsertAdmin({
        email: "admin@example.com",
        password: "correct horse battery staple",
      });
      const second = await User.upsertAdmin({
        email: "admin@example.com",
        password: "correct horse battery staple",
      });

      expect(first).toEqual({ id: 7, created: true });
      expect(second).toEqual({ id: 7, created: false });
    });
  });
});
