const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @param {string} name
 * @returns {import('esbuild').Plugin}
 */
function problemMatcherPlugin(name) {
	return {
		name: `esbuild-problem-matcher-${name}`,

		setup(build) {
			build.onStart(() => {
				console.log('[watch] build started');
			});
			build.onEnd((result) => {
				result.errors.forEach(({ text, location }) => {
					console.error(`✘ [ERROR] ${text}`);
					if (location) {
						console.error(`    ${location.file}:${location.line}:${location.column}:`);
					}
				});
				console.log('[watch] build finished');
			});
		},
	};
}

/** webview 用的 codicon 图标字体：从依赖里复制到 dist/webview/codicons（css 用相对路径引用字体文件） */
function copyCodicons() {
	const from = path.join(__dirname, 'node_modules', '@vscode', 'codicons', 'dist');
	const to = path.join(__dirname, 'dist', 'webview', 'codicons');
	fs.mkdirSync(to, { recursive: true });
	for (const file of ['codicon.css', 'codicon.ttf']) {
		fs.copyFileSync(path.join(from, file), path.join(to, file));
	}
}

async function main() {
	// 扩展本体（Node，CommonJS）
	const extensionCtx = await esbuild.context({
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
		],
		logLevel: 'silent',
		plugins: [
			/* add to the end of plugins array */
			problemMatcherPlugin('extension'),
		],
	});

	// 新界面的前端（浏览器，Preact；CSS 作为外置文件输出到 dist/webview/main.css）
	const webviewCtx = await esbuild.context({
		entryPoints: [
			'src/webview/main.tsx'
		],
		bundle: true,
		format: 'iife',
		platform: 'browser',
		target: 'es2022',
		minify: production,
		sourcemap: !production,
		sourcesContent: false,
		outfile: 'dist/webview/main.js',
		jsx: 'automatic',
		jsxImportSource: 'preact',
		tsconfig: 'src/webview/tsconfig.json',
		logLevel: 'silent',
		plugins: [
			problemMatcherPlugin('webview'),
		],
	});

	copyCodicons();

	if (watch) {
		await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
	} else {
		await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
		await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
	}
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});
