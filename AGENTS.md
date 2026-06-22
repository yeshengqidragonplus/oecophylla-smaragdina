# AGENTS.md

This file provides guidance to agents when working with code in this repository.

## 项目概述
基于 VS Code 插件的小型局域网简单通信工程。使用 TypeScript 开发，通过 esbuild 打包。

## 关键命令
- `npm run test` - 运行测试（自动先执行 compile-tests、compile、lint）
- `npm run watch` - 开发模式（并行运行 esbuild 和 tsc 监听）
- `npm run package` - 生产打包
- 单测试运行：`npm run compile-tests` 后在 VS Code 中使用测试面板

## 代码风格
- 严格模式：TypeScript strict 模式启用
- 命名：import 使用 camelCase 或 PascalCase
- 分号：必须使用分号（semi: warn）
- 大括号：必须使用（curly: warn）
- 相等比较：使用 ===（eqeqeq: warn）

## Encoding
- **Encoding**: All text/file editing tools (especially `apply_diff`) must use UTF-8 encoding when reading and writing files to correctly handle Chinese characters and special characters in comments

## Git tooling
- Git Commit Message Info,wirte like this:AI(DS4)-提交内容分类：具体内容概括，多内容时可以一句概述然后具体事项换行，1，2，3，4，...这样列出。
- Commit but never push.
- 按功能颗粒度细一点提交，以后有问题直接revert整个Commit比较方便。
- 每次提交只包含这次功能修改相关内容，不是你改的不要提交。

## 项目结构
- `src/extension.ts` - 插件入口点
- `src/test/` - 测试文件
- `dist/` - 打包输出目录（由 esbuild 生成）
- `out/` - 测试编译输出目录

## 技术栈
- VS Code Extension API (^1.110.0)
- TypeScript 5.x (Node16 模块，ES2022 目标)
- esbuild 打包
- mocha + @vscode/test-cli 测试框架

## Git tooling

- Git Commit Message Info,wirte like this:AI(AI模型简称)-提交内容分类：具体内容概括，多内容时可以一句概述然后具体事项换行，1，2，3，4，...这样列出。
- Commit but never push.
- 按功能颗粒度细一点提交，以后有问题直接revert整个Commit比较方便。
- 每次提交只包含这次功能修改相关内容，不是你改的不要提交。
- AI模型简称：DS4(deepseek v4)、GLM(glm)、MM(MiniMax)、DB(doubao)