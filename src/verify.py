"""用 Playwright 打开看板，检查渲染错误并截图。"""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8899/index.html"
OUT = Path(__file__).resolve().parent.parent / "screenshots"


def main() -> int:
    OUT.mkdir(exist_ok=True)
    errors: list[str] = []
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome")
        page = b.new_page(viewport={"width": 1560, "height": 1100}, device_scale_factor=2)
        page.on("console", lambda m: errors.append(f"[{m.type}] {m.text}") if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(f"[pageerror] {e}"))
        page.goto(URL, wait_until="networkidle")
        page.wait_for_timeout(1800)

        canvas = page.eval_on_selector_all("canvas", "els => els.length")
        score = page.inner_text("#score")
        regime = page.inner_text("#regime")
        asof = page.inner_text("#asof")
        rows = page.eval_on_selector_all("#tbody tr", "els => els.length")
        bars = page.eval_on_selector_all("#bars .brow", "els => els.length")

        print(f"canvas 数量: {canvas}")
        print(f"评分: {score} | 状态: {regime} | 数据截至: {asof}")
        print(f"表格行: {rows} | 排行条: {bars}")

        page.screenshot(path=str(OUT / "dashboard-dark.png"), full_page=True)
        page.screenshot(path=str(OUT / "dashboard-viewport.png"))

        # 切浅色主题
        page.click("#theme")
        page.wait_for_timeout(900)
        page.screenshot(path=str(OUT / "dashboard-light.png"), full_page=True)

        if errors:
            print("--- 控制台错误 ---")
            for e in dict.fromkeys(errors):
                print(" ", e)
        else:
            print("无控制台错误")
        b.close()

    ok = canvas >= 3 and rows > 0 and score not in ("", "—")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
