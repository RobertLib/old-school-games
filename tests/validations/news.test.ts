import { describe, it, expect } from "vitest";
import { validateNews, sanitizeNews } from "../../validations/news.ts";

describe("News Validations", () => {
  describe("validateNews", () => {
    it("should return no errors for valid news data", () => {
      const validData = {
        title: "Valid Title",
        content: "Valid content that is long enough",
      };

      const errors = validateNews(validData);

      expect(errors).toEqual([]);
    });

    it("should return error for missing title", () => {
      const invalidData = {
        content: "Valid content",
      };

      const errors = validateNews(invalidData);

      expect(errors).toContainEqual({
        field: "title",
        message: "Title is required",
      });
    });

    it("should return error for empty title", () => {
      const invalidData = {
        title: "   ",
        content: "Valid content",
      };

      const errors = validateNews(invalidData);

      expect(errors).toContainEqual({
        field: "title",
        message: "Title cannot be empty",
      });
    });

    it("should return error for title that is too long", () => {
      const invalidData = {
        title: "a".repeat(256),
        content: "Valid content",
      };

      const errors = validateNews(invalidData);

      expect(errors).toContainEqual({
        field: "title",
        message: "Title cannot be longer than 255 characters",
      });
    });

    it("should return error for missing content", () => {
      const invalidData = {
        title: "Valid title",
      };

      const errors = validateNews(invalidData);

      expect(errors).toContainEqual({
        field: "content",
        message: "Content is required",
      });
    });

    it("should return error for empty content", () => {
      const invalidData = {
        title: "Valid title",
        content: "   ",
      };

      const errors = validateNews(invalidData);

      expect(errors).toContainEqual({
        field: "content",
        message: "Content cannot be empty",
      });
    });

    it("should return error for content that is too long", () => {
      const invalidData = {
        title: "Valid title",
        content: "a".repeat(10001),
      };

      const errors = validateNews(invalidData);

      expect(errors).toContainEqual({
        field: "content",
        message: "Content cannot be longer than 10000 characters",
      });
    });

    it("should return multiple errors for multiple invalid fields", () => {
      const invalidData = {
        title: "",
        content: "",
      };

      const errors = validateNews(invalidData);

      expect(errors).toHaveLength(2);
      expect(errors.some((err) => err.field === "title")).toBe(true);
      expect(errors.some((err) => err.field === "content")).toBe(true);
    });
  });

  describe("sanitizeNews", () => {
    it("should trim whitespace from title and content", () => {
      const data = {
        title: "  Title with spaces  ",
        content: "  Content with spaces  ",
      };

      const sanitized = sanitizeNews(data);

      expect(sanitized.title).toBe("Title with spaces");
      expect(sanitized.content).toBe("Content with spaces");
    });

    it("should sanitize HTML in content", () => {
      const data = {
        title: "Safe title",
        content: "<p>Safe content</p><script>alert('unsafe')</script>",
      };

      const sanitized = sanitizeNews(data);

      expect(sanitized.title).toBe("Safe title");
      expect(sanitized.content).toBe("<p>Safe content</p>");
      expect(sanitized.content).not.toContain("<script>");
    });

    it("should handle undefined values", () => {
      const data = {};

      const sanitized = sanitizeNews(data);

      expect(sanitized.title).toBe("");
      expect(sanitized.content).toBe("");
    });
  });
});
