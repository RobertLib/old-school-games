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
 *
 * The same hashes answer the question from the file's side too:
 * `assetUrl.versionOf(file)` is what app.ts compares a request's ?v= with
 * before it promises the browser a year of "immutable". It used to promise
 * that to any ?v= at all, which is only safe if every machine serves the same
 * bytes — and during a rolling deploy they do not. A page rendered by a new
 * machine names style.css?v=NEW; if that request reaches a machine still on
 * the old release, the old file went out under the new address marked
 * immutable, and the browser kept it until the file changed again. One map,
 * keyed by the file on disk, so the two lookups cannot disagree.
 */
export type AssetUrl = ((urlPath: string) => string) & {
  versionOf(filePath: string): string;
};

export function createAssetUrl(publicDir: string): AssetUrl {
  const fingerprints = new Map<string, string>();
  const root = path.resolve(publicDir);

  function versionOf(file: string): string {
    let version = fingerprints.get(file);

    if (version === undefined) {
      version = fingerprint(root, file);

      // Only a real hash is remembered. fingerprint() answers "" for a file it
      // could not read, and that miss was cached for the life of the process:
      // a `npm run dev` started while the stylesheet was mid-write, or an
      // asset added by a watcher a moment after the first request for it,
      // served that address unversioned until the process was restarted — for
      // exactly the file whose changes this exists to push past a browser
      // cache. A miss now costs one readFileSync per request instead, which
      // is what a missing asset is worth.
      if (version) fingerprints.set(file, version);
    }

    return version;
  }

  function assetUrl(urlPath: string): string {
    const version = versionOf(path.resolve(root, `.${urlPath}`));

    return version ? `${urlPath}?v=${version}` : urlPath;
  }

  return Object.assign(assetUrl, { versionOf });
}

function fingerprint(root: string, file: string): string {
  // Only ever called with literals from the templates and with the files
  // express.static resolved, but a path that escapes the public directory is
  // a bug worth refusing rather than hashing.
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
