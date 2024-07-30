import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * Nothing checked the sources for unused imports or dead exports, so a whole
 * module could sit in the tree with only its own test importing it. These
 * rules exist mainly to catch that.
 *
 * The type-aware presets are deliberately not enabled: they need a full
 * program per run, and `npm run typecheck` already covers what they would add.
 */
export default tseslint.config(
  {
    ignores: ["node_modules/**", "coverage/**", "public/js-dos.html"],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Applies everywhere, server and browser alike.
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          // Express error handlers must declare `next` to be recognised as
          // one, and route handlers often take `req` they never read.
          args: "after-used",
          argsIgnorePattern: "^_|^next$|^req$|^res$",
          varsIgnorePattern: "^_",
          // "^error$" used to be here too, which meant an unused caught
          // binding was never reported under the one name almost every catch
          // block in this codebase uses — so a `catch (error) {}` that
          // swallowed something silently looked exactly like a deliberate
          // one. Optional catch binding (`catch {}`) is how a block says it
          // genuinely does not want the error, and that is what this rule now
          // makes it say.
          caughtErrorsIgnorePattern: "^_",
          // `const { omitted, ...rest } = obj` is how a property is dropped.
          ignoreRestSiblings: true,
        },
      ],
      // The models hand rows straight to the views, which are untyped anyway.
      "@typescript-eslint/no-explicit-any": "off",
      // The test helpers below opt out explicitly where they need it.
      "no-eval": "error",
    },
  },

  // Server code: Node globals, ES modules.
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
  },

  // Augmenting Express's own types is what `declare global { namespace … }`
  // is for; there is no module-syntax equivalent.
  {
    files: ["types/*.ts"],
    rules: {
      "@typescript-eslint/no-namespace": "off",
    },
  },

  // The XML serialiser exists to find the control characters XML cannot
  // carry and drop them, so a pattern matching them is the whole point of the
  // module rather than the mistake this rule is normally catching.
  {
    files: ["utils/xml.ts"],
    rules: {
      "no-control-regex": "off",
    },
  },

  // Browser code shipped from public/.
  {
    files: ["public/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: globals.browser,
    },
  },

  // The framed DOS player. `Dos` is a global from the js-dos script
  // public/js-dos.html loads off the pinned jsDelivr release, so nothing in
  // this tree declares it. (It used to name v8.js-dos.com, the vendor's
  // moving "/latest/" — that host is gone from the source and from the
  // Content-Security-Policy; see the comment at JS_DOS_ORIGIN in app.ts.)
  // This code used to be inline in public/js-dos.html — which is ignored
  // above, so it was never linted either — until the script-src nonce
  // refused it.
  {
    files: ["public/js/js-dos-player.js"],
    languageOptions: {
      globals: { Dos: "readonly" },
    },
  },

  // Tests: vitest globals are imported explicitly, but the DOM ones are not.
  {
    files: ["tests/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-expressions": "off",
    },
  },
);
