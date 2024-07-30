import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";

const window = new JSDOM("").window;
const DOMPurify = createDOMPurify(window as any);

interface NewsValidationData {
  title?: string;
  content?: string;
}

interface ValidationError {
  field: string;
  message: string;
}

export function validateNews(data: NewsValidationData): ValidationError[] {
  const errors: ValidationError[] = [];

  if (!data.title || typeof data.title !== "string") {
    errors.push({ field: "title", message: "Title is required" });
  } else if (data.title.trim().length === 0) {
    errors.push({ field: "title", message: "Title cannot be empty" });
  } else if (data.title.trim().length > 255) {
    errors.push({
      field: "title",
      message: "Title cannot be longer than 255 characters",
    });
  }

  if (!data.content || typeof data.content !== "string") {
    errors.push({ field: "content", message: "Content is required" });
  } else if (data.content.trim().length === 0) {
    errors.push({ field: "content", message: "Content cannot be empty" });
  } else if (data.content.trim().length > 10000) {
    errors.push({
      field: "content",
      message: "Content cannot be longer than 10000 characters",
    });
  }

  return errors;
}

export function sanitizeNews(data: NewsValidationData): {
  title: string;
  content: string;
} {
  return {
    title: data.title ? data.title.trim() : "",
    content: data.content ? DOMPurify.sanitize(data.content.trim()) : "",
  };
}
