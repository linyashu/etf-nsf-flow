import { createElement } from 'react'
import { DashboardSafe } from './components/Dashboard'
import tailwindCss from './tailwind-css.generated'

/**
 * Client 半：注册侧边栏入口与主面板。
 *
 * 样式注入方式与 dsh-context 一致：把编译后的 Tailwind CSS 作为字符串，
 * 运行时创建一个带 data-plugin 标记的 <style>，卸载时移除。
 */

const PLUGIN_ID = 'dsh-etf-nsf-flow'

/** 侧边栏图标：折线 + 基线，呼应「资金流」。 */
function PanelIcon({ size = 18 }: { size?: number }) {
  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      'aria-hidden': true,
      style: { display: 'block' },
    },
    createElement('path', {
      d: 'M3 17l5-6 4 3 4-6 5 4',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.9,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }),
    createElement('path', {
      d: 'M3 21h18',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.5,
      strokeLinecap: 'round',
      opacity: 0.45,
    }),
  )
}

/** 注入一次样式，返回清理函数。 */
function injectStyles(): () => void {
  if (typeof document === 'undefined') return () => {}

  const selector = `style[data-plugin="${PLUGIN_ID}"]`
  if (document.head.querySelector(selector)) return () => {}

  const el = document.createElement('style')
  el.dataset.plugin = PLUGIN_ID
  el.textContent = tailwindCss
  document.head.appendChild(el)

  return () => {
    el.remove()
  }
}

interface ClientCtx {
  effect: (fn: () => (() => void) | void) => void
  slots: {
    inject: (name: string, cb: () => () => void) => () => void
    register: (opts: Record<string, unknown>, comp: unknown) => () => void
  }
}

const mod = {
  name: PLUGIN_ID,
  inject: ['slots'],
  apply(ctx: ClientCtx) {
    ctx.effect(() => injectStyles())

    // 侧边栏文案直接给中文常量。
    // 注意：ctx.locale.bind() 对未注册的命名空间会回退成 key 本身
    // （返回字面量 "panel.title"），?? 兜不住，所以不依赖 locale。
    const label = (): string => '国家队'

    // 侧边栏入口：id 与 main 面板的 key 一致，点击即切到看板
    ctx.effect(() =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'etf-nsf-flow', order: 30, label },
          PanelIcon,
        ),
      ),
    )

    // 主面板
    ctx.effect(() =>
      ctx.slots.inject('main', () =>
        ctx.slots.register({ name: 'main', key: 'etf-nsf-flow' }, DashboardSafe),
      ),
    )
  },
}

export default mod
