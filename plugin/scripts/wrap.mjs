/**
 * 把 tsdown 输出的 CJS 包成宿主的 client 模块外壳：
 *   window.__ModuleLoader__.load({ id, factory(require) { ... return exports } })
 *
 * 宿主的 factory 会传入 require，用来取 react / react-dom 等共享模块。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const id = pkg.name

const bundle = readFileSync(resolve(root, 'dist/client.cjs'), 'utf8')

const wrapped = `/**
 * ${pkg.name} v${pkg.version}
 * ${pkg.description ?? ''}
 * Built ${new Date().toISOString()}
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory(require) {
    var module = { exports: {} };
    var exports = module.exports;
    (function (module, exports, require) {
${bundle}
    })(module, exports, require);
    // ESM 编译产物把插件对象挂在 default 上；宿主期望直接拿到 { name, inject, apply }
    var out = module.exports;
    return out && out.default ? out.default : out;
  },
});
`

const out = resolve(root, 'dist/client.bundle.js')
writeFileSync(out, wrapped, 'utf8')

// 最终产物写到包根，供 package.json 的 ./client 导出
const finalPath = resolve(root, 'client.js')
writeFileSync(finalPath, wrapped, 'utf8')

const kb = (wrapped.length / 1024).toFixed(1)
console.log(`已生成 ${finalPath} (${kb} KB, id=${id})`)
