const esbuild = require('esbuild');

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
};

(async () => {
  if (process.argv.includes('--watch')) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
    console.log('[esbuild] watching...');
    return;
  }
  await esbuild.build(options);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
