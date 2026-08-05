import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Globbed at every depth: the mcp workspace has its own dist/ and node_modules/.
  { ignores: ["**/dist/**", "**/node_modules/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    // These are not part of the TS program, so type-aware rules cannot run on
    // them and would otherwise fail with "not found by the project service".
    files: ["eslint.config.js", "scripts/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
      },
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      // Underscore-prefixed parameters are intentionally unused — the type
      // tests declare signatures purely to assert what does and does not compile.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
  {
    // Tests deliberately provoke type errors and poke at internals.
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
    },
  },
);
