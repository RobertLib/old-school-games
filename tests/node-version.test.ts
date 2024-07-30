import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf-8");
}

/**
 * The Node version is written in four files and nothing made them agree.
 *
 * `nvm use` reads .nvmrc, `npm ci` refuses an install outside package.json's
 * "engines" because .npmrc sets engine-strict, the image is built FROM
 * node:${NODE_VERSION}-slim, and fly.toml passes that build argument for a
 * remote `fly deploy`. Four copies of one number, moved by hand, and the one
 * that matters most is the one nobody runs locally: the image. This app is
 * started as `node index.ts` and relies on the runtime stripping the type
 * annotations, which needs 22.18 or newer — a Dockerfile left on an older
 * default builds cleanly and then refuses to boot, which is a failure that
 * only appears after the tests have gone green.
 *
 * Major only, on purpose. .nvmrc may name an exact release ("24.5.0") while
 * "engines" is a range ("^24") and the image tag is the floating major — those
 * are three correct spellings of the same decision, and pinning them to one
 * string would make an ordinary patch bump a four-file change. What must never
 * differ is which major they mean.
 *
 * Modelled on tests/public-assets.test.ts, which keeps MEDIA_ORIGIN and the
 * js-dos release honest across the files that each have to restate them.
 */
describe("the Node version, in the four places it is written", () => {
  /** The major a version string names, whatever form it is written in. */
  function major(value: string | undefined, where: string): number {
    expect(value, `no Node version found in ${where}`).toBeDefined();

    const digits = /(\d+)/.exec(value!)?.[1];

    expect(digits, `${where} names no version number: ${value}`).toBeDefined();

    return Number(digits);
  }

  const nvmrc = major(read(".nvmrc").trim(), ".nvmrc");

  const engines = major(
    (JSON.parse(read("package.json")) as { engines?: { node?: string } })
      .engines?.node,
    'package.json "engines".node',
  );

  const dockerfile = major(
    /^ARG\s+NODE_VERSION=(\S+)/m.exec(read("Dockerfile"))?.[1],
    "ARG NODE_VERSION in the Dockerfile",
  );

  const flyToml = major(
    /^\s*NODE_VERSION\s*=\s*"([^"]+)"/m.exec(read("fly.toml"))?.[1],
    "NODE_VERSION in fly.toml",
  );

  it("names a major recent enough to strip type annotations", () => {
    // Not a style rule: `node index.ts` is the CMD, and stripping is what
    // makes it work. 22 is the floor; this project is on 24 and the check
    // below is what keeps the other three there with it.
    expect(nvmrc).toBeGreaterThanOrEqual(22);
  });

  it("agrees across .nvmrc, package.json, the Dockerfile and fly.toml", () => {
    // Reported as one object rather than four assertions, so a failure names
    // every file at once and the odd one out is visible by eye.
    expect({ nvmrc, engines, dockerfile, flyToml }).toEqual({
      nvmrc,
      engines: nvmrc,
      dockerfile: nvmrc,
      flyToml: nvmrc,
    });
  });

  /**
   * The fifth place, which is deliberately not a fifth copy.
   *
   * The workflow's setup-node reads .nvmrc through node-version-file, and the
   * image CI builds is given --build-arg NODE_VERSION from the same file — so
   * neither restates the number and neither can drift. This checks the two
   * stayed that way, because the ordinary way to "fix" a version in a workflow
   * is to type it in.
   */
  it("has CI read .nvmrc rather than repeat it", () => {
    const workflow = read(".github/workflows/fly-deploy.yml");

    expect(workflow).toContain("node-version-file: .nvmrc");
    expect(workflow).toMatch(/NODE_VERSION=\$\{\{[^}]*nvmrc[^}]*\}\}/);
  });
});
