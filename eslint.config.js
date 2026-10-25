import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", "saves", "eslint.config.js"] },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Numbers in text are everywhere ("You have $50").
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // `(g) => g.write(text)` is the normal way to write a one-line script.
      "@typescript-eslint/no-confusing-void-expression": ["error", { ignoreArrowShorthand: true }],
      // Text is drawn one code point per screen cell (it's all CP437), so
      // splitting strings into code points with `...` is what we want.
      "@typescript-eslint/no-misused-spread": "off",
    },
  },
);
