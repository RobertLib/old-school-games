import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../scripts/backup-media.sh", import.meta.url));
let workspace: string;
let source: string;
let destination: string;
let bin: string;
let calls: string;

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "osg-backup-test-"));
  source = path.join(workspace, "source");
  destination = path.join(workspace, "backup");
  bin = path.join(workspace, "bin");
  calls = path.join(workspace, "rclone-calls");
  for (const directory of [source, destination, bin]) mkdirSync(directory);
  writeFileSync(path.join(source, "game.jsdos"), "original game");
  writeFileSync(path.join(source, "cover.png"), "original cover");

  // A filesystem-backed stand-in: exercise snapshot preservation and failed
  // verification without requiring storage credentials or rclone in CI.
  writeFileSync(path.join(bin, "rclone"), `#!/usr/bin/env bash
set -euo pipefail
command="$1"; shift
printf '%s\\n' "$command" >> "$BACKUP_TEST_CALLS"
case "$command" in
  copy)
    for arg in "$@"; do [[ "$arg" != --dry-run ]] || exit 0; done
    mkdir -p "$2"
    cp -R "$1/." "$2/"
    ;;
  check)
    [[ "\${BACKUP_TEST_FAIL_CHECK:-}" != 1 ]] || exit 9
    diff -r "$1" "$2" >/dev/null
    ;;
  lsjson) printf '[]\\n' ;;
  copyto) cp "$1" "$2" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

function backup(overrides: Record<string, string> = {}, args: string[] = []) {
  return spawnSync("bash", [script, ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MEDIA_BACKUP_SOURCE: source,
      MEDIA_BACKUP_DESTINATION: destination,
      BACKUP_TEST_CALLS: calls,
      ...overrides,
    },
    encoding: "utf8",
  });
}

describe("media backups", () => {
  it("preserves older copies after a production file is changed or deleted", () => {
    expect(backup().status).toBe(0);
    const first = path.join(destination, readdirSync(destination)[0]);
    writeFileSync(path.join(source, "game.jsdos"), "new game");
    rmSync(path.join(source, "cover.png"));
    expect(backup().status).toBe(0);
    expect(readdirSync(destination)).toHaveLength(2);
    expect(readFileSync(path.join(first, "objects", "game.jsdos"), "utf8")).toBe("original game");
    expect(readFileSync(path.join(first, "objects", "cover.png"), "utf8")).toBe("original cover");
    expect(JSON.parse(readFileSync(path.join(first, "complete.json"), "utf8")).version).toBe(1);
  });

  it("does not mark a failed verification as a completed backup", () => {
    expect(backup({ BACKUP_TEST_FAIL_CHECK: "1" }).status).toBe(9);
    const partial = path.join(destination, readdirSync(destination)[0]);
    expect(readdirSync(partial)).toEqual(["objects"]);
    expect(readFileSync(path.join(source, "game.jsdos"), "utf8")).toBe("original game");
  });

  it("leaves both storage locations unchanged during a dry run", () => {
    expect(backup({}, ["--dry-run"]).status).toBe(0);
    expect(readdirSync(destination)).toEqual([]);
    expect(readdirSync(source).sort()).toEqual(["cover.png", "game.jsdos"]);
  });

  it("refuses a destination within the source and missing configuration", () => {
    expect(backup({ MEDIA_BACKUP_DESTINATION: path.join(source, "backup") }).status).toBe(2);
    expect(backup({ MEDIA_BACKUP_SOURCE: "" }).status).not.toBe(0);
    expect(readdirSync(destination)).toEqual([]);
    expect(readdirSync(source).sort()).toEqual(["cover.png", "game.jsdos"]);
    expect(existsSync(calls)).toBe(false);
  });

  it.each([
    ["media:", "media:backup"],
    ["media:/", "media:/backup"],
    ["media:bucket/..", "media:backup"],
    ["media:bucket", "media:bucket/../bucket/backup"],
    ["media:bucket", "media:bucket//./backup"],
    ["media:bucket/games", "media:bucket/games//"],
  ])("refuses overlapping remote paths %s and %s before calling rclone", (from, to) => {
    const result = backup({ MEDIA_BACKUP_SOURCE: from, MEDIA_BACKUP_DESTINATION: to }, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(calls)).toBe(false);
  });

  it.each([
    ["source", "source/backup"],
    ["./source/.", "./backup/../source/new/backup"],
    ["source", "absolute-child"],
    ["absolute-source", "./source/backup"],
  ])("refuses equivalent local paths %s and %s before calling rclone", (from, to) => {
    const result = backup({
      MEDIA_BACKUP_SOURCE: from === "absolute-source" ? source : from,
      MEDIA_BACKUP_DESTINATION: to === "absolute-child" ? path.join(source, "backup") : to,
    }, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(calls)).toBe(false);
    expect(readdirSync(source).sort()).toEqual(["cover.png", "game.jsdos"]);
  });

  it("resolves source and destination directory symlinks before checking overlap", () => {
    const alias = path.join(workspace, "source-alias");
    symlinkSync(source, alias, "dir");
    for (const [from, to] of [
      [source, alias],
      [source, path.join(alias, "new", "backup")],
      [alias, path.join(source, "backup")],
    ]) {
      const result = backup({ MEDIA_BACKUP_SOURCE: from, MEDIA_BACKUP_DESTINATION: to }, ["--dry-run"]);
      expect(result.status, result.stderr).toBe(2);
    }
    expect(existsSync(calls)).toBe(false);
    expect(readdirSync(source).sort()).toEqual(["cover.png", "game.jsdos"]);
  });

  it("resolves dot segments after a symlink using its physical parent", () => {
    const nested = path.join(source, "nested");
    mkdirSync(nested);
    const alias = path.join(workspace, "nested-alias");
    symlinkSync(nested, alias, "dir");
    const result = backup({ MEDIA_BACKUP_DESTINATION: `${alias}/../new/backup` }, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(calls)).toBe(false);
    expect(readdirSync(nested)).toEqual([]);
  });

  it("rejects a dangling destination symlink into the source", () => {
    const alias = path.join(workspace, "new-backup-alias");
    symlinkSync(path.join("source", "new-backup"), alias, "dir");
    const result = backup({ MEDIA_BACKUP_DESTINATION: alias }, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(path.join(source, "new-backup"))).toBe(false);
  });

  it("rejects a destination symlink loop without calling rclone", () => {
    const alias = path.join(workspace, "backup-loop");
    symlinkSync("backup-loop", alias, "dir");
    const result = backup({ MEDIA_BACKUP_DESTINATION: alias }, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toMatch(/symlink loop/);
    expect(existsSync(calls)).toBe(false);
  });

  it("copies using the resolved local paths after checking symlinks and dot segments", () => {
    const nested = path.join(source, "nested");
    mkdirSync(nested);
    const sourceAlias = path.join(workspace, "nested-alias");
    const destinationAlias = path.join(workspace, "backup-alias");
    symlinkSync(nested, sourceAlias, "dir");
    symlinkSync(destination, destinationAlias, "dir");
    const result = backup({
      MEDIA_BACKUP_SOURCE: `${sourceAlias}/..`,
      MEDIA_BACKUP_DESTINATION: `${destinationAlias}/new`,
    });
    expect(result.status, result.stderr).toBe(0);
    const snapshots = path.join(destination, "new");
    const snapshot = path.join(snapshots, readdirSync(snapshots)[0]);
    expect(readFileSync(path.join(snapshot, "objects", "game.jsdos"), "utf8")).toBe("original game");
    expect(readFileSync(path.join(snapshot, "complete.json"), "utf8")).toContain('"version":1');
    expect(readdirSync(source).sort()).toEqual(["cover.png", "game.jsdos", "nested"]);
  });

  it.each([
    ["media:bucket/games", "media:bucket/games-backup"],
    ["media:", "independent:backup"],
    ["source", "./source-backup"],
    ["./source/.", "./source/../backup/new"],
  ])("allows separate paths %s and %s", (from, to) => {
    const result = backup({ MEDIA_BACKUP_SOURCE: from, MEDIA_BACKUP_DESTINATION: to }, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(calls, "utf8")).toBe("copy\n");
    expect(readdirSync(source).sort()).toEqual(["cover.png", "game.jsdos"]);
    expect(readdirSync(destination)).toEqual([]);
  });

  it("requires inline remote definitions to use a configured remote instead", () => {
    const result = backup({ MEDIA_BACKUP_SOURCE: ":s3:bucket" }, ["--dry-run"]);
    expect(result.status, result.stderr).toBe(2);
    expect(existsSync(calls)).toBe(false);
  });
});
