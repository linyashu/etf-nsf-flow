/**
 * 构建 client 半的完整流程，与 dsh-context 的技术栈一致：
 *
 *   1. Tailwind CSS v4 编译 styles/tailwind.css
 *   2. 把编译结果写成 src/tailwind-css.generated.ts（CSS 字符串模块）
 *   3. tsdown 打包 TSX -> dist/client.js (CJS)
 *   4. 包一层 window.__ModuleLoader__.load({ id, factory(require) }) 外壳
 *
 * 最终产物是包根目录的 client.js，由 package.json 的 "./client" 导出。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))

const run = (cmd, args, opts = {}) => {
  process.stdout.write(`\n$ ${cmd} ${args.join(' ')}\n`)
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts })
}

mkdirSync(resolve(root, 'dist'), { recursive: true })
mkdirSync(resolve(root, '.build'), { recursive: true })

// 1) Tailwind v4 编译
const cssOut = resolve(root, '.build/tailwind.css')
run(
  resolve(root, 'node_modules/.bin/tailwindcss'),
  ['--input', 'styles/tailwind.css', '--output', cssOut, '--minify'],
)

// 2) 生成 CSS 字符串模块
const css = readFileSync(cssOut, 'utf8')
const cssModule = `/* 自动生成，请勿手改。源文件：styles/tailwind.css */
const css = ${JSON.stringify(css)}
export default css
`
writeFileSync(resolve(root, 'src/tailwind-css.generated.ts'), cssModule, 'utf8')
console.log(`\n生成 src/tailwind-css.generated.ts (${(css.length / 1024).toFixed(1)} KB CSS)`)

// 3) tsdown 打包
run(resolve(root, 'node_modules/.bin/tsdown'), [])

// 4) 包 ModuleLoader 外壳
run(process.execPath, ['scripts/wrap.mjs'])

const finalSize = readFileSync(resolve(root, 'client.js'), 'utf8').length
console.log(`\n构建完成：client.js ${(finalSize / 1024).toFixed(1)} KB (id=${pkg.name})`)
