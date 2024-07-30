import crypto from "node:crypto";
import fs from "node:fs/promises";
import { readdirSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import type { RequestHandler } from "express";
import logger from "./logger.ts";

/**
 * Serves the compressible files under `root` compressed once per process,
 * rather than once per request.
 *
 * Written for js-dos, which app.ts serves out of node_modules. The global
 * compression() middleware compressed every response from scratch, and for
 * the emulator that is real work: gzip on wdosbox-x.wasm (7.8 MB) is ~170 ms
 * of CPU, wdosbox.wasm ~35 ms. Those files are answered above the rate
 * limiter and the access log, so anyone could loop on one with
 * "Accept-Encoding: gzip" — unthrottled and unrecorded — on a machine with
 * one shared CPU. jsDelivr, which served them until the emulator moved onto
 * this origin, compressed once and cached; this is the same arrangement.
 *
 * The files are in a release directory that never changes under a running
 * process, so each (file, encoding) pair is compressed the first time it is
 * asked for and the result is kept. Lazily, so a file nobody plays costs no
 * memory; the cache is bounded by the installed release's files at both
 * encodings — it is keyed by the files found at startup, never by anything
 * in the request.
 *
 * Anything this does not answer falls through to `next`, which is
 * express.static with the same Cache-Control: a client that accepts neither
 * encoding, a Range request (a byte offset into the file as stored, which a
 * compressed body is not), a file outside EXTENSIONS, any spelling of a path
 * that is not one of the files exactly as listed — express.static decodes and
 * resolves those itself, safely — and a compression that failed.
 */
export function precompressed(
  root: string,
  { cacheControl }: { cacheControl: string },
): RequestHandler {
  const files = listFiles(root);
  const cache = new Map<string, Promise<Entry>>();

  function load(file: string, encoding: Encoding): Promise<Entry> {
    const key = `${encoding}\0${file}`;
    let entry = cache.get(key);

    if (!entry) {
      entry = compress(file, encoding);
      // A failure is not remembered: the next request tries again rather than
      // being sent uncompressed for the life of the process.
      entry.catch(() => cache.delete(key));
      cache.set(key, entry);
    }

    return entry;
  }

  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.headers.range) return next();

    const file = files.get(req.path);

    if (!file) return next();

    // Brotli first whenever it is accepted at all. Asked together,
    // acceptsEncodings ranks by the order the client lists them in, and
    // Chrome sends "gzip, deflate, br, zstd" — so the smaller of the two
    // would never be chosen. compression() makes the same choice.
    const encoding: Encoding | null = req.acceptsEncodings("br")
      ? "br"
      : req.acceptsEncodings("gzip")
        ? "gzip"
        : null;

    if (!encoding) return next();

    load(file, encoding).then(
      (entry) => {
        res.vary("Accept-Encoding");
        res.setHeader("Content-Encoding", encoding);
        res.type(path.extname(file));
        res.setHeader("Cache-Control", cacheControl);
        res.setHeader("ETag", entry.etag);
        res.setHeader("Last-Modified", entry.lastModified);

        if (req.fresh) {
          res.status(304).end();
          return;
        }

        res.setHeader("Content-Length", entry.body.length);
        res.end(req.method === "HEAD" ? undefined : entry.body);
      },
      (error: unknown) => {
        logger.error(`Could not precompress ${file}: ${String(error)}`);
        next();
      },
    );
  };
}

type Encoding = "br" | "gzip";

interface Entry {
  body: Buffer;
  etag: string;
  lastModified: string;
}

/**
 * What compression() would have compressed of a js-dos release: the
 * emulator's wasm, its scripts, its stylesheets and their source maps. The
 * rest — .symbols, the sprite, the font — is a type compression() leaves
 * alone anyway.
 */
const EXTENSIONS = new Set([".wasm", ".js", ".mjs", ".css", ".map"]);

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

async function compress(file: string, encoding: Encoding): Promise<Entry> {
  const [data, stat] = await Promise.all([fs.readFile(file), fs.stat(file)]);

  // Brotli at quality 6, not 11. It is paid on a live request — the first one
  // for each file on each machine — and 11 took ~11.6 s on wdosbox-x.wasm
  // where 6 takes ~90 ms, for a body ~13% smaller. 6 is still ~8% smaller
  // than the quality 4 compression() used per request.
  const body =
    encoding === "br"
      ? await brotliCompress(data, {
          params: {
            [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
          },
        })
      : await gzip(data);

  // Strong and per encoding: the two bodies are different bytes, and an ETag
  // shared with the identity response express.static sends would let a cache
  // answer a revalidation for one with the other.
  const hash = crypto.createHash("sha256").update(data).digest("base64url");

  return {
    body,
    etag: `"${hash.slice(0, 27)}-${encoding}"`,
    lastModified: stat.mtime.toUTCString(),
  };
}

/**
 * Every file under `root` worth compressing, by the path a request names it
 * with ("/emulators/wdosbox.wasm"). Read once: a release does not change
 * under a running process, and a lookup in this map is the whole of what a
 * request's path is ever matched against — so no spelling of it can reach a
 * file outside the release.
 */
function listFiles(root: string): Map<string, string> {
  const files = new Map<string, string>();
  let names: string[];

  try {
    names = readdirSync(root, { recursive: true, encoding: "utf8" });
  } catch {
    // No release installed: every request falls through to express.static,
    // which answers 404 just as it would have.
    return files;
  }

  for (const name of names) {
    if (!EXTENSIONS.has(path.extname(name))) continue;

    files.set(`/${name.split(path.sep).join("/")}`, path.join(root, name));
  }

  return files;
}
