import "express-session";

declare module "express-session" {
  interface Session {
    user?: {
      id: number;
      email: string;
      role?: string;
    };
  }
}
