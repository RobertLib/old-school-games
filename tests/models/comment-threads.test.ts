import { beforeEach, describe, expect, it } from "vitest";
import pool from "../../db.ts";
import Comment, { REPLIES_PER_ROOT } from "../../models/comment.ts";
import Game from "../../models/game.ts";

/**
 * What findByGameId's window actually returns, against a real database.
 *
 * The mocked comment suite can only read back the SQL that was built, so it
 * can say the query partitions by thread but not that the partitioning
 * produces the right rows — and the window is the entire fix. The roots were
 * paged from the start; their replies were not, so twenty popular threads
 * meant one query and one render of every reply ever written under them.
 */
describe("Comment thread windowing", () => {
  let gameId: number;

  beforeEach(async () => {
    await pool.query('DELETE FROM "comments"');
    await pool.query('DELETE FROM "games"');

    const game = await Game.create({ title: "Thread Test", genre: "ACTION" });

    gameId = game.id;
  });

  const reply = async (parentId: number, content: string) =>
    Comment.create({ nick: "b", content, gameId, parentId });

  const root = async (content: string) =>
    Comment.create({ nick: "a", content, gameId, parentId: null });

  it("caps a busy thread and reports what it left out", async () => {
    const busy = await root("busy");
    const over = 10;

    for (let n = 0; n < REPLIES_PER_ROOT + over; n++) {
      await reply(busy.id, `reply ${n}`);
    }

    const [loaded] = await Comment.findByGameId(gameId);

    expect(loaded!.replies).toHaveLength(REPLIES_PER_ROOT);
    expect(loaded!.hiddenReplies).toBe(over);
  });

  it("counts a deep chain against the thread, not against each parent", async () => {
    const busy = await root("busy");
    const over = 5;

    // A chain rather than a fan-out: every reply answers the one before it,
    // so each has exactly one child. Partitioning on "parentId" would give
    // every one of them its own window of fifty and cap nothing at all.
    let parentId = busy.id;

    for (let n = 0; n < REPLIES_PER_ROOT + over; n++) {
      parentId = (await reply(parentId, `deep ${n}`)).id;
    }

    const [loaded] = await Comment.findByGameId(gameId);

    expect(loaded!.replies).toHaveLength(REPLIES_PER_ROOT);
    expect(loaded!.hiddenReplies).toBe(over);
  });

  /**
   * The newest, shown oldest first. The cut used to keep the first fifty, so
   * the note under a full thread called the newest replies "older" and a reply
   * posted to it disappeared on reload.
   */
  it("keeps the newest replies, in reading order", async () => {
    const busy = await root("busy");
    const ids: number[] = [];

    for (let n = 0; n < REPLIES_PER_ROOT + 10; n++) {
      ids.push((await reply(busy.id, `reply ${n}`)).id);
    }

    const [loaded] = await Comment.findByGameId(gameId);

    expect(loaded!.replies.map((r) => r.id)).toEqual(
      ids.slice(-REPLIES_PER_ROOT),
    );
    expect(loaded!.hiddenReplies).toBe(10);
  });

  /**
   * What the old prefix was protecting, and why it no longer needs to: a
   * reply's parent can now be one of the replies the cut dropped. Each reply
   * is filed under the root the query found it under, not by walking up
   * through the rows that came back, so it cannot be orphaned by the cut.
   */
  it("keeps a reply whose parent reply the cut dropped", async () => {
    const busy = await root("busy");
    const first = await reply(busy.id, "the first reply");

    for (let n = 0; n < REPLIES_PER_ROOT; n++) {
      await reply(busy.id, `reply ${n}`);
    }

    const late = await reply(first.id, "an answer to the first reply");

    const [loaded] = await Comment.findByGameId(gameId);
    const shown = loaded!.replies.map((r) => r.id);

    expect(shown).not.toContain(first.id);
    expect(shown).toContain(late.id);
    expect(shown).toHaveLength(REPLIES_PER_ROOT);
  });

  it("windows each thread on its own, not the batch as a whole", async () => {
    const busy = await root("busy");
    const quiet = await root("quiet");

    for (let n = 0; n < REPLIES_PER_ROOT + 3; n++) {
      await reply(busy.id, `reply ${n}`);
    }

    await reply(quiet.id, "the only one");

    const loaded = await Comment.findByGameId(gameId);
    const byContent = new Map(loaded.map((c) => [c.content, c]));

    // A quiet thread beside a busy one must not lose its single reply to the
    // busy one's budget.
    expect(byContent.get("quiet")!.replies).toHaveLength(1);
    expect(byContent.get("quiet")!.hiddenReplies).toBe(0);
    expect(byContent.get("busy")!.replies).toHaveLength(REPLIES_PER_ROOT);
  });

  it("leaves a thread that fits completely alone", async () => {
    const small = await root("small");

    await reply(small.id, "one");
    await reply(small.id, "two");

    const [loaded] = await Comment.findByGameId(gameId);

    expect(loaded!.replies).toHaveLength(2);
    expect(loaded!.hiddenReplies).toBe(0);
  });

  it("does not change what the heading counts", async () => {
    const busy = await root("busy");

    for (let n = 0; n < REPLIES_PER_ROOT + 7; n++) {
      await reply(busy.id, `reply ${n}`);
    }

    // The window is about what one page renders. countAll is what the "N
    // comments" heading reads, and it must still be the truth.
    expect(await Comment.countAll(gameId)).toBe(REPLIES_PER_ROOT + 7 + 1);
  });
});
