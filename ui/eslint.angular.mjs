import angular from "@angular-eslint/eslint-plugin";
import template from "@angular-eslint/eslint-plugin-template";
import templateParser from "@angular-eslint/template-parser";
import parser from "@babel/eslint-parser";
import { componentFiles } from "../tools/angular-layout.mjs";

export default [
  {
    files: ["ui/src/**/*.ts"],
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
    plugins: {
      "@angular-eslint": angular,
      berth: { rules: { "component-files": componentFiles } },
    },
    rules: {
      "berth/component-files": "error",
      "@angular-eslint/use-component-selector": "error",
      "@angular-eslint/component-selector": [
        "error",
        { type: "element", prefix: "berth", style: "kebab-case" },
      ],
      "@angular-eslint/directive-selector": [
        "error",
        { type: "attribute", prefix: "berth", style: "camelCase" },
      ],
      "@angular-eslint/prefer-inject": "error",
      "@angular-eslint/inject-at-top": "error",
      "@angular-eslint/prefer-standalone": "error",
      "@angular-eslint/prefer-on-push-component-change-detection": "error",
      "@angular-eslint/prefer-host-metadata-property": "error",
      "@angular-eslint/prefer-signals": "error",
      "@angular-eslint/prefer-output-readonly": "error",
      "@angular-eslint/relative-url-prefix": "error",
      "@angular-eslint/use-lifecycle-interface": "error",
      "@angular-eslint/no-async-lifecycle-method": "error",
    },
  },
  {
    files: ["ui/src/**/*.html"],
    languageOptions: { parser: templateParser },
    plugins: { "@angular-eslint/template": template },
    rules: {
      "@angular-eslint/template/no-any": "error",
      "@angular-eslint/template/prefer-control-flow": "error",
      "@angular-eslint/template/eqeqeq": "error",
    },
  },
];
