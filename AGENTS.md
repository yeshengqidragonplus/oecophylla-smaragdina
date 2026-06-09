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
