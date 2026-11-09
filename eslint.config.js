// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".cache/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Template literals with numbers are how every log and summary line is built.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Floating promises in an MCP server lose errors silently; keep this strict.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      eqeqeq: ["error", "always"],
      // Index access is already checked by noUncheckedIndexedAccess; the remaining `!`s
      // are in geometry loops whose bounds make the index provably valid.
      "@typescript-eslint/no-non-null-assertion": "off",
      // Style-only; conflicts with concise event-handler and promise-resolver arrows.
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },
  {
    files: ["src/**/*.ts"],
    rules: {
      // stdout carries JSON-RPC framing on a stdio MCP server. A single console.log
      // corrupts the protocol. Log through src/log.ts, which writes to stderr.
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "stdout",
          message: "stdout belongs to the MCP transport. Use src/log.ts (stderr).",
        },
      ],
    },
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // node:test's test() returns a promise the runner tracks; awaiting it is wrong.
      "@typescript-eslint/no-floating-promises": "off",
      // Tests assert on loosely typed protocol payloads.
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Fetch doubles are async to match the fetch signature without awaiting anything.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
