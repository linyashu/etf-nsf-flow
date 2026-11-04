import { defineConfig } from 'tsdown'

/**
 * 产物形态与 dsh-context 一致：单文件，包进
 * window.__ModuleLoader__.load({ id, factory(require) })
 *
 * 这里先输出 CJS，再由 scripts/wrap.mjs 包一层 factory 外壳 —— CJS 的
 * module.exports 能直接作为 factory 的返回值，比处理 ESM 导出更稳。
 * react / react-dom 保持 external，从宿主模块表取，不重复打包。
 */
export default defineConfig({
  entry: { client: 'src/client.tsx' },
  outDir: 'dist',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: true,
  sourcemap: false,
  deps: {
    neverBundle: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  },
  define: {
    'process.env.NODE_ENV': '"production"',
  },
  outputOptions: {
    exports: 'named',
  },
})
