import typescriptEslint from "typescript-eslint";
import { fileURLToPath } from "node:url";

export default [{
    files: ["**/*.ts", "**/*.tsx"],
}, {
    plugins: {
        "@typescript-eslint": typescriptEslint.plugin,
    },

    languageOptions: {
        parser: typescriptEslint.parser,
        ecmaVersion: 2022,
        sourceType: "module",
        parserOptions: {
            // 类型感知规则（no-floating-promises）需要读取 tsconfig
            projectService: true,
            tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
        },
    },

    rules: {
        "@typescript-eslint/naming-convention": ["warn", {
            selector: "import",
            format: ["camelCase", "PascalCase"],
        }],
        // 事件处理里大量异步调用：漏 await / 漏 catch 的 Promise 会让错误静默消失
        "@typescript-eslint/no-floating-promises": "warn",
        "@typescript-eslint/no-unused-vars": ["warn", {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrors: "none",
        }],

        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "warn",
    },
}];
