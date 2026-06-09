import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Initialisation effects (setState to seed derived state) are intentional here
      "react-hooks/set-state-in-effect": "off",
    },
  },
  {
    ignores: ["dist/**", "node_modules/**"],
  }
);
