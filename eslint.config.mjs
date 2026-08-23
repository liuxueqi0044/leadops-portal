import js from "@eslint/js";
import nextPlugin from "@next/eslint-plugin-next";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.next/**",
      "**/pnpm-lock.yaml",
      "**/next-env.d.ts",
      "**/*.d.ts",
      "tests/load/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "eslint.config.mjs",
            "vitest.config.ts",
            "vitest.db.config.ts",
            "vitest.integration.config.ts",
            "vitest.e2e.config.ts",
            "acceptance/phase-3.mjs",
            "acceptance/phase-4.mjs",
            "acceptance/n8n-import.mjs",
            "acceptance/phase-5.mjs",
            "apps/web/next.config.ts",
            "packages/db/scripts/migrate.ts",
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 12,
          defaultProject: "tsconfig.root.json",
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: {
      "@next/next": nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
    settings: {
      next: {
        rootDir: "apps/web",
      },
    },
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ["apps/worker/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["packages/**/*.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ["**/*.db.test.ts"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/*.integration.test.ts", "**/*.e2e.test.ts"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      "eslint.config.mjs",
      "**/vitest*.config.ts",
      "**/next.config.ts",
      "acceptance/**/*.mjs",
    ],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/restrict-plus-operands": "off",
      "no-control-regex": "off",
    },
  },
  {
    files: ["eslint.config.mjs"],
    rules: {
      "@typescript-eslint/no-deprecated": "off",
    },
  },
);
