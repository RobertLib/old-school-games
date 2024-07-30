import { describe, it, expect } from "vitest";
import { validateNews, normalizeNews } from "../../validations/news.ts";

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

  describe("normalizeNews", () => {
    it("should trim whitespace from title and content", () => {
      const data = {
        title: "  Title with spaces  ",
        content: "  Content with spaces  ",
      };

      const normalized = normalizeNews(data);

      expect(normalized.title).toBe("Title with spaces");
      expect(normalized.content).toBe("Content with spaces");
    });

    it("leaves the writer's markup alone", () => {
      const data = {
        title: "Safe title",
        content: "<p>Safe content</p><script>alert('unsafe')</script>",
      };

      const normalized = normalizeNews(data);

      // Deliberately unsanitized: News.create and News.update are the single
      // place markup gets cleaned, so an article is transformed once rather
      // than passing through DOMPurify here as well. What reaches a reader is
      // covered by tests/models/news.test.ts.
      expect(normalized.content).toBe(data.content);
    });

    it("should handle undefined values", () => {
      const data = {};

      const normalized = normalizeNews(data);

      expect(normalized.title).toBe("");
      expect(normalized.content).toBe("");
    });
  });

  describe("validateNews content length", () => {
    it("measures the sanitized length, not the raw one", () => {
      // Sanitizing grows this: DOMPurify escapes each "<" to "&lt;", so 2500
      // of them become 10000 characters and the entity for the 2501st tips it
      // over. Raw it is well inside the limit, which is the trap — the column
      // receives the sanitized form.
      const errors = validateNews({
        title: "Valid title",
        content: "<".repeat(2501),
      });

      expect(errors).toContainEqual({
        field: "content",
        message: "Content cannot be longer than 10000 characters",
      });
    });

    it("accepts markup that only grows to within the limit", () => {
      const errors = validateNews({
        title: "Valid title",
        content: "<".repeat(2500),
      });

      expect(errors).toEqual([]);
    });
  });
});
