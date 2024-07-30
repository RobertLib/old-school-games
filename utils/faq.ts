/**
 * One question and its answer, as both are shown and described.
 *
 * Plain text rather than markup, because the same string is rendered into the
 * page *and* into the JSON-LD beside it. schema.org would accept a little HTML
 * in an answer, but then the visible copy and the described copy would be two
 * strings that merely start out the same — which is the drift
 * utils/breadcrumbs.ts was written to close, where a hand-built
 * BreadcrumbList had wandered away from the trail the page actually drew.
 *
 * The price is that an answer cannot carry a <kbd> the way the prose further
 * up /how-to-play does; the key names are written out instead.
 */
export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * The questions /how-to-play answers.
 *
 * Every one of these is answered at length somewhere on that page already —
 * this is the same guidance stated as a question, which is the form both a
 * reader with a specific problem and a search engine are looking for. Google
 * asks that structured data describe what is on the page, so the section is
 * rendered from this array as well as marked up from it: views/how-to-play.ejs
 * draws the visible FAQ by iterating the same export the JSON-LD is built
 * from, and neither can say something the other does not.
 *
 * A note on what this does and does not buy, so it is not rediscovered later:
 * Google stopped showing FAQ rich results for general websites in August 2023
 * — they are limited to government and health sites now — and HowTo results
 * were withdrawn outright at the same time. So this will not put an expander
 * under the result in Google, and it is not here on that promise. It is here
 * because FAQPage is still a valid, widely consumed description of a page's
 * content: Bing still renders it, and answer engines read it to find the one
 * paragraph that answers a question rather than the whole guide. The visible
 * section is worth having on its own merits regardless.
 */
export const HOW_TO_PLAY_FAQ: readonly FaqEntry[] = [
  {
    question: "How do I start playing an MS-DOS game in my browser?",
    answer:
      "Open any game page and wait a few seconds for the emulator to load, " +
      "then click inside the game window to give it keyboard and mouse " +
      "focus. Nothing has to be downloaded or installed. If the game waits " +
      "on a title screen, press any key to continue.",
  },
  {
    question: "How do I play a DOS game in fullscreen?",
    answer:
      "Press Alt + Enter while the game window is focused. The same " +
      "shortcut switches back out of fullscreen again.",
  },
  {
    question: "How do I save my progress in an MS-DOS game?",
    answer:
      "It depends on the game — DOS had no universal save standard. Most " +
      "RPGs and adventure games have a Save Game option in a menu reached " +
      "with Esc or F1. Many action and strategy games use save and load " +
      "keys, commonly F5 to save and F7 or F8 to load. Some late-80s " +
      "titles do not save at all and give you a password at the end of each " +
      "level instead, and arcade-style games usually have no save feature. " +
      "If you are unsure, check whether the game has a manual linked on its " +
      "page.",
  },
  {
    question: "How do I get my mouse cursor out of the game window?",
    answer:
      "Some games — first-person shooters and strategy games especially — " +
      "capture the cursor so it stays inside the game. Press Ctrl + F10 to " +
      "release it, and click inside the game again to recapture it.",
  },
  {
    question: "Why is there no sound in the game?",
    answer:
      "Many DOS games were written for specific sound hardware such as " +
      "AdLib, Sound Blaster or the PC speaker. The emulator picks a matching " +
      "card automatically, but some games still need sound configured from " +
      "their own setup — look for a Sound Setup or Options entry, or a " +
      "SETUP.EXE or SETSOUND.EXE in the game's start menu. Also check your " +
      "browser and system volume, since some games default to a very low " +
      "level.",
  },
  {
    question: "The game will not start or the keyboard does nothing. Why?",
    answer:
      "Click directly on the game window first — it needs focus before it " +
      "receives any input, and your browser may otherwise intercept some key " +
      "combinations. Some games also wait for a key press before they begin, " +
      "and larger games can take a few extra seconds to boot in the emulator.",
  },
  {
    question: "Do I need to install DOSBox or download anything?",
    answer:
      "No. The games run through js-dos, a DOSBox build compiled for the " +
      "browser, so everything happens on the page itself. There is no " +
      "download, no installation and no plugin.",
  },
];

/**
 * A set of questions as schema.org FAQPage.
 *
 * Takes the entries rather than reading HOW_TO_PLAY_FAQ directly, so a second
 * page with its own questions needs nothing here but its own array.
 *
 * Worth knowing before anybody plans around it: this will not produce the rich
 * result it used to. In August 2023 Google narrowed FAQ rich results to
 * "well-known, authoritative government and health websites", and a hobby
 * catalogue of DOS games is neither — so the questions are not going to appear
 * under the search result however correct the markup is.
 *
 * It stays anyway, and the reason is not sentiment. The markup is valid, it
 * costs a few hundred bytes on one page, Bing still renders FAQ results from
 * it, and it states plainly what the page is for anything reading the page as
 * data rather than as prose. What it must not do is set an expectation: if the
 * questions never show up in Google, that is this paragraph and not a bug.
 *
 * The visible FAQ on /how-to-play is the part that was always doing the work.
 * It answers what people actually search for, and it ranks as ordinary page
 * content — which is untouched by any of the above.
 */
export function faqLdJson(
  entries: readonly FaqEntry[],
): Record<string, unknown> | null {
  if (entries.length === 0) return null;

  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: entry.answer,
      },
    })),
  };
}
