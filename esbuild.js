const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
	name: 'esbuild-problem-matcher',

	setup(build) {
		build.onStart(() => {
			console.log('[watch] build started');
		});
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`);
				console.error(`    ${location.file}:${location.line}:${location.column}:`);
			});
			console.log('[watch] build finished');
		});
	},
};

/**
 * 处理 .node 原生模块的插件
 * 将 .node 文件复制到输出目录，并在 bundle 中保留 require 引用
 * @type {import('esbuild').Plugin}
 */
const nativeNodePlugin = {
	name: 'native-node-plugin',
	setup(build) {
		// 拦截 .node 文件的加载，将其标记为外部
		build.onResolve({ filter: /\.node$/ }, (args) => {
			return {
				path: path.resolve(args.resolveDir, args.path),
				external: true,
			};
		});

		// 构建完成后，将外部依赖复制到 dist 目录
		build.onEnd(() => {
			// 复制 .node 原生模块
			const nativeModules = [
				'@ronomon/reed-solomon/binding.node',
			];
			for (const mod of nativeModules) {
				const src = path.resolve(__dirname, 'node_modules', mod);
				const dest = path.resolve(__dirname, 'dist', path.basename(mod));
				if (fs.existsSync(src) && !fs.existsSync(dest)) {
					fs.mkdirSync(path.dirname(dest), { recursive: true });
					fs.copyFileSync(src, dest);
					console.log(`[native-node-plugin] Copied ${mod} to dist/`);
				}
			}

			// 复制 kcpjs 的 dist 目录（作为外部依赖）
			const kcpjsSrc = path.resolve(__dirname, 'node_modules', 'kcpjs', 'dist');
			const kcpjsDest = path.resolve(__dirname, 'dist', 'kcpjs');
			if (fs.existsSync(kcpjsSrc) && !fs.existsSync(kcpjsDest)) {
				fs.cpSync(kcpjsSrc, kcpjsDest, { recursive: true });
				console.log(`[native-node-plugin] Copied kcpjs dist to dist/kcpjs/`);
			}
		});
	},
};

async function main() {
	const ctx = await esbuild.context({
		entryPoints: [
			'src/extension.ts'
		],
		bundle: true,
		format: 'cjs',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		platform: 'node',
		outfile: 'dist/extension.js',
		external: [
			'vscode',
			'kcpjs',
			'@ronomon/reed-solomon',
		],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			esbuildProblemMatcherPlugin,
			nativeNodePlugin,
		],
	});
	if (watch) {
		await ctx.watch();
	} else {
		await ctx.rebuild();
		await ctx.dispose();
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
