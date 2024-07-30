import { describe, expect, it } from "vitest";
import { genreInSentence, genreLabel } from "../../utils/genre-label.ts";

/**
 * The genre as a reader sees it. Every title, heading, breadcrumb and sidebar
 * link used to title-case the enum by hand — right for "Action", and "Rpg" for
 * the one initialism in the list.
 */
describe("genreLabel", () => {
  it.each([
    ["ACTION", "Action"],
    ["action", "Action"],
    ["Platformer", "Platformer"],
  ])("writes %s as a heading does: %s", (genre, label) => {
    expect(genreLabel(genre)).toBe(label);
  });

  it.each(["RPG", "rpg", "Rpg"])("keeps the initialism %s in capitals", (genre) => {
    expect(genreLabel(genre)).toBe("RPG");
  });
});

describe("genreInSentence", () => {
  it("lower-cases an ordinary genre, as a common noun is written", () => {
    expect(genreInSentence("ACTION")).toBe("action");
  });

  it("leaves an initialism in capitals mid-sentence too", () => {
    expect(genreInSentence("RPG")).toBe("RPG");
  });
});
