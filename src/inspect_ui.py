"""视觉与布局体检：不依赖人眼看图，用 DOM 度量替代。"""
from __future__ import annotations

import json
import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8899/index.html"

SCRIPT = """
() => {
  const out = { overflow: [], charts: [], clipped: [] };
  // 1. 横向溢出检测
  if (document.documentElement.scrollWidth > window.innerWidth + 2) {
    out.overflow.push({ what: 'document', scrollW: document.documentElement.scrollWidth, winW: window.innerWidth });
  }
  // 2. 各图表 canvas 实际尺寸 + 是否已绘制
  document.querySelectorAll('.chart').forEach((el, i) => {
    const cv = el.querySelector('canvas');
    const r = el.getBoundingClientRect();
    let painted = false;
    if (cv) {
      const ctx = cv.getContext('2d');
      if (ctx) {
        // 全图稀疏采样：中心区域图表（雷达/饼）在左上角是空白，不能只看局部
        const W = cv.width, H = cv.height;
        outer:
        for (let gx = 1; gx <= 8; gx++) {
          for (let gy = 1; gy <= 8; gy++) {
            const x = Math.floor(W * gx / 9), y = Math.floor(H * gy / 9);
            const d = ctx.getImageData(x, y, 1, 1).data;
            if (d[3] !== 0) { painted = true; break outer; }
          }
        }
      }
    }
    out.charts.push({
      id: el.id, w: Math.round(r.width), h: Math.round(r.height),
      canvasW: cv ? cv.width : 0, canvasH: cv ? cv.height : 0, painted
    });
  });
  // 3. 文字截断检测（内容溢出容器）
  document.querySelectorAll('.card, .brow, td, .regime, .note').forEach(el => {
    if (el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflow === 'hidden') {
      out.clipped.push({ cls: el.className, text: (el.innerText || '').slice(0, 24) });
    }
  });
  return out;
}
"""


def main() -> int:
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome")
        ok = True
        for theme in ("dark", "light"):
            page = b.new_page(viewport={"width": 1560, "height": 1100})
            page.goto(URL, wait_until="networkidle")
            page.wait_for_timeout(1500)
            if theme == "light":
                page.click("#theme")
                page.wait_for_timeout(900)
            r = page.evaluate(SCRIPT)
            print(f"\n===== {theme.upper()} =====")
            if r["overflow"]:
                ok = False
                print("横向溢出:", json.dumps(r["overflow"], ensure_ascii=False))
            else:
                print("横向溢出: 无")
            for c in r["charts"]:
                flag = "OK " if c["painted"] and c["w"] > 100 and c["h"] > 100 else "BAD"
                if flag == "BAD":
                    ok = False
                print(f"  {flag} #{c['id']:12s} {c['w']}x{c['h']} canvas {c['canvasW']}x{c['canvasH']} painted={c['painted']}")
            if r["clipped"]:
                print("  截断元素:", json.dumps(r["clipped"][:5], ensure_ascii=False))
            page.close()
        b.close()
    print("\n结果:", "通过" if ok else "存在缺陷")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
