import parser from "@babel/eslint-parser";
import stylistic from "@stylistic/eslint-plugin";

// Match export wrappers as well as plain declarations; keep leading JSDoc attached.
const functions = {
  selector:
    'FunctionDeclaration, ExportNamedDeclaration[declaration.type="FunctionDeclaration"], ExportDefaultDeclaration[declaration.type="FunctionDeclaration"]',
};

export default [
  {
    files: ["**/*.ts", "**/*.mjs"],
    languageOptions: {
      parser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["typescript", "decorators"] },
        },
      },
    },
    plugins: { "@stylistic": stylistic },
    rules: {
      "@stylistic/padding-line-between-statements": [
        "error",
        { blankLine: "always", prev: "*", next: functions },
        { blankLine: "always", prev: functions, next: "*" },
      ],
    },
  },
];
