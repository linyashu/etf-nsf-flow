"""交互验证：周期切换、表格点选、主题切换是否真的改变 DOM/图表。"""
from __future__ import annotations

import sys

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8899/index.html"


def main() -> int:
    fails: list[str] = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome")
        page = b.new_page(viewport={"width": 1560, "height": 1100})
        errs: list[str] = []
        page.on("pageerror", lambda e: errs.append(str(e)))
        page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(1400)

        def label():
            return page.inner_text("#rank-meta")

        # 1) 周期切换
        base = label()
        for n, expect in (("1", "近 1 日"), ("5", "近 5 日"), ("10", "近 10 日"), ("20", "近 20 日")):
            page.click(f'#look button[data-k="{n}"]')
            page.wait_for_timeout(500)
            got = label()
            if expect not in got:
                fails.append(f"周期 {n} 文案未更新: {got}")
        page.click('#look button[data-k="5"]')
        page.wait_for_timeout(400)

        # 2) 表格首行净申购值随周期变化
        page.click('#look button[data-k="1"]')
        page.wait_for_timeout(500)
        v1 = page.eval_on_selector("#tbody tr td:nth-child(6)", "e => e.innerText")
        page.click('#look button[data-k="20"]')
        page.wait_for_timeout(500)
        v20 = page.eval_on_selector("#tbody tr td:nth-child(6)", "e => e.innerText")
        if v1 == v20:
            fails.append(f"表格区间净申购未随周期变化: {v1}")
        page.click('#look button[data-k="5"]')
        page.wait_for_timeout(400)

        # 3) 点击表格行 -> 底部图表标题跟着换
        rows = page.query_selector_all("#tbody tr")
        if len(rows) < 2:
            fails.append("表格行不足")
        else:
            rows[1].click()
            page.wait_for_timeout(700)
            title = page.evaluate(
                "() => { const el=document.getElementById('c-fund');"
                "const i=echarts.getInstanceByDom(el);"
                "return i ? (i.getOption().title?.[0]?.text || '') : ''; }"
            )
            if not title:
                fails.append("点击行后图表标题为空")

        # 4) 主题切换持久化
        page.click("#theme")
        page.wait_for_timeout(700)
        th = page.get_attribute("html", "data-theme")
        if th != "light":
            fails.append(f"主题未切换到 light: {th}")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(1200)
        th2 = page.get_attribute("html", "data-theme")
        if th2 != "light":
            fails.append(f"主题未持久化: {th2}")

        # 5) 区间切换不影响图表崩溃
        page.click('#range button[data-n="all"]')
        page.wait_for_timeout(800)
        painted = page.evaluate(
            "() => { const el=document.getElementById('c-flow');"
            "const cv=el.querySelector('canvas'); if(!cv) return false;"
            "const c=cv.getContext('2d'); if(!c) return false;"
            "for(let i=1;i<10;i++){for(let j=1;j<10;j++){"
            "  const d=c.getImageData(Math.floor(cv.width*i/10),Math.floor(cv.height*j/10),1,1).data;"
            "  if(d[3]!==0) return true;}}"
            "return false; }"
        )
        if not painted:
            fails.append("切到全部区间后主图未绘制")

        if errs:
            fails.extend([f"console: {e}" for e in dict.fromkeys(errs)])
        b.close()

    if fails:
        print("交互验证失败:")
        for f in fails:
            print("  -", f)
        return 1
    print("交互验证全部通过：周期切换 / 表格联动 / 主题持久化 / 区间切换")
    return 0


if __name__ == "__main__":
    sys.exit(main())
