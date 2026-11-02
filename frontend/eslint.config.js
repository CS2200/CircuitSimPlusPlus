import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

/**
 * The two rules everyone means by "the hooks lint". react-hooks v7 widened
 * `configs.recommended` to also carry the whole **React Compiler** ruleset
 * (refs, purity, set-state-in-effect, …), which this code predates. Those are
 * surfaced as warnings so they stay visible without failing the build until we
 * migrate; the classic two keep their recommended levels.
 */
const CLASSIC_HOOK_RULES = new Set(["react-hooks/rules-of-hooks", "react-hooks/exhaustive-deps"]);

export default tseslint.config(
  { ignores: ["dist", "playwright-report", "test-results"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...Object.fromEntries(
        Object.entries(reactHooks.configs.recommended.rules).map(([rule, level]) => [
          rule,
          CLASSIC_HOOK_RULES.has(rule) ? level : "warn",
        ]),
      ),
    },
  },
);
