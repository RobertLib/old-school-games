import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf-8");
}

/** Every line inside a fenced code block: the commands a reader will paste. */
function codeLines(markdown: string): string[] {
  const lines: string[] = [];
  let inside = false;

  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) {
      inside = !inside;
      continue;
    }

    if (inside) lines.push(line.trim());
  }

  return lines;
}

/**
 * The commands the docs give, held to what the code does with them.
 *
 * Both of these were found by running what a document said and getting
 * something else: a setup step that exits 1, and a script described as the
 * one thing it is not. Neither the README nor CONTRIBUTING.md is executed by
 * anything, so this is the only place either claim is checked.
 */
describe("the commands the docs give", () => {
  /**
   * create-admin.ts exits 1 with "No email given." when it has neither an
   * argument nor ADMIN_EMAIL, and CONTRIBUTING.md's setup told every new
   * contributor to run exactly that.
   */
  it("never runs create-admin without an email", () => {
    // The premise, checked rather than assumed.
    expect(read("create-admin.ts")).toContain('fail("No email given.")');

    for (const doc of ["README.md", "CONTRIBUTING.md"]) {
      // Invocations only: the README's project tree names the file inside a
      // code block too, and that is not a command anyone runs.
      const runs = codeLines(read(doc)).filter((line) =>
        /\bnpm run create-admin\b|\bnode\s+\S*create-admin\.ts\b/.test(line),
      );

      expect(runs.length, `${doc} shows no create-admin command`).toBeGreaterThan(0);
      expect(
        runs.filter(
          (line) =>
            !/ADMIN_EMAIL=\S+|create-admin(?:\.ts)?\s+(?:--\s+)?\S+@\S+/.test(line),
        ),
        `${doc} runs create-admin with no email`,
      ).toEqual([]);
    }
  });

  /**
   * `npm start` loads .env and changes nothing else, and .env.example sets
   * NODE_ENV=development — so what it starts is the app without the file
   * watcher. The README called it production mode, twice, while production
   * runs `node index.ts` under the NODE_ENV that fly.toml and the Dockerfile
   * set.
   */
  it("does not call npm start production mode", () => {
    expect(read(".env.example")).toMatch(/^NODE_ENV=development$/m);
    expect(
      (JSON.parse(read("package.json")) as { scripts: Record<string, string> })
        .scripts.start,
    ).not.toContain("NODE_ENV=production");

    const readme = read("README.md").split("\n");

    expect(
      readme.filter(
        (line, index) =>
          /\bnpm start\b/.test(line) &&
          (/production mode/i.test(line) ||
            /production mode/i.test(readme[index - 1] ?? "")),
      ),
    ).toEqual([]);
  });
});
