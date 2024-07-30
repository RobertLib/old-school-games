import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Turns "/js/ui.js" into "/js/ui.js?v=<content hash>".
 *
 * The stylesheet and the scripts are served with a cache lifetime, and their
 * addresses used to be fixed — so a fix to ui.js or style.css reached anyone
 * who had already visited only whenever their copy happened to expire, up to
 * a day later. The hash changes with the file, which makes the address change
 * with it, which is what actually invalidates a browser cache.
 *
 * Hashes are read once and remembered: the files cannot change under a
 * running process, and the middleware would otherwise read every asset from
 * disk on every page.
 */
export function createAssetUrl(publicDir: string): (urlPath: string) => string {
  const fingerprints = new Map<string, string>();
  const root = path.resolve(publicDir);

  return function assetUrl(urlPath: string): string {
    let version = fingerprints.get(urlPath);

    if (version === undefined) {
      version = fingerprint(root, urlPath);
      fingerprints.set(urlPath, version);
    }

    return version ? `${urlPath}?v=${version}` : urlPath;
  };
}

function fingerprint(root: string, urlPath: string): string {
  const file = path.resolve(root, `.${urlPath}`);

  // Only ever called with literals from the templates, but a path that
  // escapes the public directory is a bug worth refusing rather than hashing.
  if (file !== root && !file.startsWith(root + path.sep)) return "";

  try {
    return crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex")
      .slice(0, 10);
  } catch {
    // A missing file is left unversioned rather than taking the page down;
    // express.static will answer the request with its own 404.
    return "";
  }
}
