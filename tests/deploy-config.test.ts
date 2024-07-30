import { describe, expect, it } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { CONCURRENT_LOCK_TIMEOUT } from "../utils/migrations.ts";
import { SHUTDOWN_TIMEOUT_MS } from "../utils/shutdown.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(file: string): string {
  return readFileSync(path.join(ROOT, file), "utf-8");
}

/**
 * Every key in a TOML file, by the table it lands in ("deploy.release_command"),
 * with its raw value.
 *
 * Not a TOML parser — it knows headers, keys and comment lines, which is all
 * fly.toml uses — but it reads them the way TOML does, and that is the point.
 * Indentation means nothing in TOML: a key belongs to the last [table] above
 * it. fly.toml's kill_timeout sat below [env], indented like a top-level key,
 * and was an environment variable for as long as it was there.
 */
function tomlKeys(text: string): Map<string, string> {
  const keys = new Map<string, string>();
  let table = "";

  for (const raw of text.split("\n")) {
    const line = raw.trim();

    if (line === "" || line.startsWith("#")) continue;

    const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);

    if (header) {
      table = header[1];
      continue;
    }

    const entry = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);

    if (entry) keys.set(table ? `${table}.${entry[1]}` : entry[1], entry[2]);
  }

  return keys;
}

/** "15m", "10m0s", "1h" (flyctl) or "5min", "5s" (Postgres), in minutes. */
function minutes(duration: string): number {
  const unquoted = duration.replace(/^["']|["']$/g, "");
  const match = /^(\d+)(h|m|min|s)?(?:0s)?$/.exec(unquoted);

  expect(match, `not a duration this test reads: ${duration}`).not.toBeNull();

  const amount = Number(match![1]);
  const unit = match![2] ?? "s";

  return unit === "h" ? amount * 60 : unit === "s" ? amount / 60 : amount;
}

const fly = tomlKeys(read("fly.toml"));

describe("fly.toml", () => {
  it("serves the production player from a separate site", () => {
    const player = new URL(JSON.parse(fly.get("env.PLAYER_ORIGIN")!));
    const site = JSON.parse(fly.get("env.CANONICAL_HOST")!);
    expect(player.protocol).toBe("https:");
    expect(player.host).toBe(`${fly.get("app")!.replace(/^["']|["']$/g, "")}.fly.dev`);
    expect(player.host).not.toBe(site);
  });

  /**
   * Fly's default kill_signal is SIGINT. index.ts handles that as well, as
   * the Ctrl+C path for development, so the drain worked — by accident, while
   * every comment describing a deploy said SIGTERM.
   */
  it("stops a machine with SIGTERM, which index.ts drains on", () => {
    expect(fly.get("kill_signal")).toBe('"SIGTERM"');
    expect(read("index.ts")).toMatch(/process\.on\(\s*"SIGTERM"/);
  });

  // Top-level, where the platform reads them — not in [env], where the
  // machine gets a variable named after them and the platform's default.
  it("sets kill_signal and kill_timeout as machine settings, not environment variables", () => {
    expect([...fly.keys()].filter((key) => key.startsWith("env.kill_"))).toEqual([]);
    expect(fly.has("kill_timeout")).toBe(true);
  });

  it("gives the drain its fallback well before the kill arrives", () => {
    const killTimeoutMs = Number(fly.get("kill_timeout")) * 1000;

    // The fallback has to finish logging and leave on its own before SIGKILL.
    expect(killTimeoutMs).toBeGreaterThanOrEqual(SHUTDOWN_TIMEOUT_MS * 2);
  });

  /**
   * Fly kills a release command after five minutes unless told otherwise,
   * and five minutes is exactly how long migrate.ts waits for another run's
   * advisory lock — so a run that waited it out was killed the moment it got
   * the lock. The release has to hold the lock wait, a concurrent build's
   * wait for older transactions, and still leave room for the work.
   */
  it("gives the release command room beyond every wait migrate.ts allows", () => {
    const release = minutes(fly.get("deploy.release_command_timeout") ?? "5m");
    const advisoryLock = Number(
      /const ADVISORY_LOCK_TIMEOUT_MINUTES = (\d+);/.exec(read("migrate.ts"))?.[1] ?? 0,
    );

    expect(advisoryLock).toBeGreaterThan(0);
    expect(release).toBeGreaterThanOrEqual(
      advisoryLock + minutes(CONCURRENT_LOCK_TIMEOUT) + 5,
    );
  });

  // flyctl drives the rolling restart from the runner, so a job timeout that
  // fires first kills the deploy halfway through.
  it("has the deploy job outlast the release command and the restart after it", () => {
    const workflow = read(".github/workflows/fly-deploy.yml");
    const deployJob = workflow.slice(workflow.search(/^ {2}deploy:$/m));
    const jobTimeout = Number(/timeout-minutes:\s*(\d+)/.exec(deployJob)?.[1]);

    expect(jobTimeout).toBeGreaterThanOrEqual(
      minutes(fly.get("deploy.release_command_timeout") ?? "5m") + 10,
    );
  });

  /**
   * "Re-run" reuses the run's own commit, so re-running an older run after a
   * newer one had deployed put the older code back into production, with
   * nothing to say so. The release is held to the tip of main.
   */
  it("releases only the commit main is at now", () => {
    const workflow = read(".github/workflows/fly-deploy.yml");
    const deployJob = workflow.slice(workflow.search(/^ {2}deploy:$/m));
    const release = /- run: flyctl deploy[^\n]*\n\s*if: (.*)/.exec(deployJob);

    expect(deployJob).toContain("git ls-remote origin refs/heads/main");
    expect(release?.[1]).toBe("steps.tip.outputs.current == 'true'");
  });

  /**
   * The action's SHA is pinned because it runs with FLY_API_TOKEN, and its
   * default installs the latest flyctl — so without a version the CLI that
   * holds the token was still whatever Fly published that day.
   */
  it("pins the flyctl it installs, wherever it installs one", () => {
    const workflow = read(".github/workflows/fly-deploy.yml");
    const setups = [
      ...workflow.matchAll(/uses: superfly\/flyctl-actions\/setup-flyctl@[^\n]*\n((?:\s+(?:if|with|version):.*\n)*)/g),
    ];

    expect(setups.length).toBeGreaterThan(0);

    for (const [, options] of setups) {
      expect(options).toMatch(/version: \d+\.\d+\.\d+/);
    }
  });
});

describe("Dockerfile", () => {
  const dockerfile = read("Dockerfile");
  const lines = dockerfile.split("\n");
  const finalStage = lines.slice(
    lines.findLastIndex((line) => /^FROM\s/i.test(line)),
  );

  /**
   * The runtime user used to own /app (--chown=node:node), so the process
   * could rewrite its own code, views and public/ — and nothing it does
   * writes there. Root-owned, it can read them and change none of them.
   */
  it("runs as node without handing node the app", () => {
    const copies = finalStage.filter((line) => /^COPY\b/i.test(line));

    expect(copies.length).toBeGreaterThan(0);
    expect(copies.filter((line) => /--chown/.test(line))).toEqual([]);
    expect(finalStage).toContain("USER node");
  });
});

describe(".github/dependabot.yml", () => {
  /**
   * dependabot-core's Dockerfile parser (docker/lib/dependabot/docker/
   * file_parser.rb) makes a FROM line a dependency only when this finds a tag
   * or a digest on it — `version_from` is `tag || digest`, and a line with
   * neither is skipped. An ARG in the tag is not a tag, and a stage name has
   * none, so the Docker entry this file used to carry watched nothing.
   */
  const DEPENDABOT_FROM =
    /^FROM\s+(?:--platform=\S+\s+)?[^\s:@]+(?::(?<tag>\w[\w.-]{0,127}))?(?:@sha256:(?<digest>[0-9a-f]{64}))?/i;

  it("does not ask for Docker updates to a Dockerfile it cannot read", () => {
    const watchesDocker = /package-ecosystem:\s*["']?docker["']?\s*$/m.test(
      read(".github/dependabot.yml"),
    );

    const unreadable = read("Dockerfile")
      .split("\n")
      .filter((line) => /^FROM\s/i.test(line))
      .filter((line) => {
        const found = DEPENDABOT_FROM.exec(line)?.groups;

        return !found?.tag && !found?.digest;
      });

    // Either no Docker entry, or a Dockerfile it can actually parse.
    expect(watchesDocker ? unreadable : []).toEqual([]);
  });

  // The check above reads the Dockerfile the way Dependabot does, so it has to
  // see what Dependabot sees: nothing in the lines this repository has, and a
  // version once a literal one is written.
  it("reads a FROM line the way Dependabot does", () => {
    const version = (line: string) => {
      const found = DEPENDABOT_FROM.exec(line)?.groups;

      return found?.tag ?? found?.digest;
    };

    expect(version("FROM node:${NODE_VERSION}-slim AS base")).toBeUndefined();
    expect(version("FROM base AS build")).toBeUndefined();
    expect(version("FROM node:24-slim AS base")).toBe("24-slim");
  });
});
