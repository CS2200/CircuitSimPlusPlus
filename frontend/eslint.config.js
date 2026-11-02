import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "playwright-report", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    // react-hooks v7's `recommended` carries the React Compiler ruleset
    // (refs, purity, set-state-in-effect, …). The code satisfies it — see
    // docs/dependencies.md for the one scoped suppression and the rationale.
    rules: {
      ...reactHooks.configs.recommended.rules,
    },
  },
);
