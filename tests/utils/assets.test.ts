import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { createAssetUrl } from "../../utils/assets.ts";

/**
 * A real directory rather than a mocked "fs".
 *
 * What this module does is hash the bytes on disk and remember the answer, so
 * the two things worth asserting — that the version follows the content, and
 * that it is read exactly once — are about the filesystem rather than about
 * anything the module computes. Stubbing readFileSync would leave both to the
 * stub. A temporary directory costs a few milliseconds and tests the thing.
 */
let root: string;

/** The version string the implementation is expected to produce. */
const versionOf = (contents: string) =>
  crypto.createHash("sha256").update(contents).digest("hex").slice(0, 10);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "osg-assets-"));
  fs.mkdirSync(path.join(root, "js"));
  fs.writeFileSync(path.join(root, "js", "ui.js"), "console.log(1);");
  fs.writeFileSync(path.join(root, "style.css"), "body{}");
  fs.writeFileSync(path.join(root, "..", "outside-the-public-dir.txt"), "no");
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(root, "..", "outside-the-public-dir.txt"), {
    force: true,
  });
});

describe("createAssetUrl", () => {
  it("appends a content hash as a ?v= query", () => {
    const assetUrl = createAssetUrl(root);

    expect(assetUrl("/js/ui.js")).toBe(`/js/ui.js?v=${versionOf("console.log(1);")}`);
  });

  it("uses the file's own bytes, so two files get two versions", () => {
    const assetUrl = createAssetUrl(root);

    expect(assetUrl("/js/ui.js")).not.toBe(assetUrl("/style.css"));
    expect(assetUrl("/style.css")).toBe(`/style.css?v=${versionOf("body{}")}`);
  });

  // The point of the whole module: the address has to change when the file
  // does, or a cached copy is served until it expires on its own.
  it("gives an edited file a different version", () => {
    const before = createAssetUrl(root)("/style.css");

    fs.writeFileSync(path.join(root, "style.css"), "body{color:red}");

    try {
      expect(createAssetUrl(root)("/style.css")).not.toBe(before);
    } finally {
      fs.writeFileSync(path.join(root, "style.css"), "body{}");
    }
  });

  // Ten hex characters of sha256 — short enough to read in a page source,
  // long enough that two versions of one file will not collide.
  it("produces a ten-character hex version", () => {
    const query = createAssetUrl(root)("/js/ui.js").split("?v=")[1];

    expect(query).toMatch(/^[0-9a-f]{10}$/);
  });

  it("reads each file once and remembers the answer", () => {
    const assetUrl = createAssetUrl(root);
    const first = assetUrl("/style.css");

    // Changing the file behind a version that has already been handed out
    // must not change it: the middleware calls this on every page render,
    // and the files cannot change under a running process anyway.
    fs.writeFileSync(path.join(root, "style.css"), "body{color:blue}");

    try {
      expect(assetUrl("/style.css")).toBe(first);
    } finally {
      fs.writeFileSync(path.join(root, "style.css"), "body{}");
    }
  });

  it("remembers per url, not just the last one asked for", () => {
    const assetUrl = createAssetUrl(root);

    const js = assetUrl("/js/ui.js");
    const css = assetUrl("/style.css");

    expect(assetUrl("/js/ui.js")).toBe(js);
    expect(assetUrl("/style.css")).toBe(css);
    expect(js).not.toBe(css);
  });

  // express.static answers the request with its own 404; taking the page
  // down over a missing stylesheet would be the worse failure.
  it("leaves a missing file unversioned rather than throwing", () => {
    const assetUrl = createAssetUrl(root);

    expect(assetUrl("/js/not-here.js")).toBe("/js/not-here.js");
  });

  it("leaves a directory unversioned too", () => {
    // Resolves to the public directory itself, which readFileSync refuses.
    expect(createAssetUrl(root)("/")).toBe("/");
    expect(createAssetUrl(root)("/js")).toBe("/js");
  });

  // Only ever called with literals from the templates, but a path that
  // escapes the public directory is a bug worth refusing rather than hashing.
  it("refuses a path that escapes the public directory", () => {
    const assetUrl = createAssetUrl(root);

    expect(assetUrl("/../outside-the-public-dir.txt")).toBe(
      "/../outside-the-public-dir.txt",
    );
  });

  it("does not treat a sibling directory with the same prefix as inside", () => {
    const sibling = `${root}-evil`;
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "secret.js"), "secret");

    try {
      const assetUrl = createAssetUrl(root);
      const escaped = `/../${path.basename(sibling)}/secret.js`;

      expect(assetUrl(escaped)).toBe(escaped);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("resolves the public directory it was given, relative or not", () => {
    const relative = path.relative(process.cwd(), root);
    const assetUrl = createAssetUrl(relative);

    expect(assetUrl("/js/ui.js")).toBe(
      `/js/ui.js?v=${versionOf("console.log(1);")}`,
    );
  });

  it("keeps two instances independent", () => {
    const one = createAssetUrl(root);
    const two = createAssetUrl(root);

    expect(one("/js/ui.js")).toBe(two("/js/ui.js"));
  });
});
