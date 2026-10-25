import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";

export default defineConfig(
  { ignores: ["node_modules", "saves", "eslint.config.js"] },
  ...tseslint.configs.strictTypeChecked,
  {
    plugins: {
      "@stylistic": stylistic,
    },
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // --- Existing Custom Exceptions & Logic ---
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      "@typescript-eslint/no-misused-spread": "off",
      "@typescript-eslint/unbound-method": "off",
      
      // --- PHP PER Coding Style Translations ---
      "curly": ["error", "all"],
      "@stylistic/indent": ["error", 4, { SwitchCase: 1 }],
      "@stylistic/brace-style": ["error", "1tbs", { allowSingleLine: false }],
      "@stylistic/space-in-parens": ["error", "never"],

      // PER Layout & Structural Standards
      "@stylistic/semi": ["error", "always"],
      "@stylistic/quotes": ["error", "single", { avoidEscape: true }],
      "@stylistic/comma-dangle": ["error", "always-multiline"],
      "@stylistic/keyword-spacing": ["error", { before: true, after: true }],
      "@stylistic/object-curly-spacing": ["error", "always"],
      "@stylistic/array-bracket-spacing": ["error", "never"],
      // PER Section 2.3: no trailing whitespace; files end with one newline
      "@stylistic/no-trailing-spaces": "error",
      "@stylistic/eol-last": ["error", "always"],

      // PER Section 4.3: Explicit method and property visibility
      "@typescript-eslint/explicit-member-accessibility": ["error", { accessibility: "explicit" }],
      "@typescript-eslint/method-signature-style": ["error", "method"],
    },
  },
);
