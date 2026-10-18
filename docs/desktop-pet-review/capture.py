import os, sys, json, time
from pathlib import Path
sys.path.insert(0, r'C:\Users\32437\.codex\tmp\pet-review-py')
from playwright.sync_api import sync_playwright

OUT = Path(__file__).parent / 'evidence'
with sync_playwright() as p:
    browser = p.chromium.launch(channel='chrome', headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000}, device_scale_factor=1)
    for name, url in [('mimikko','https://www.mimikko.cn/#/intro'), ('airi','https://airi.moeru.ai/'), ('mate','https://github.com/shinyflvre/Mate-Engine')]:
        try:
            page.goto(url, wait_until='domcontentloaded', timeout=45000)
            page.wait_for_timeout(5000)
            page.screenshot(path=str(OUT / (name+'-top.png')))
            (OUT/(name+'-dom.json')).write_text(json.dumps({'url':page.url,'text':page.locator('body').inner_text(),'links':page.locator('a').evaluate_all('(els)=>els.map(e=>({text:e.innerText,url:e.href}))'),'images':page.locator('img').evaluate_all('(els)=>els.map(e=>({alt:e.alt,src:e.src}))'),'videos':page.locator('video').evaluate_all('(els)=>els.map(e=>({src:e.src,poster:e.poster}))')},ensure_ascii=False,indent=2),encoding='utf-8')
            if name=='mimikko':
                for i in range(1,5):
                    page.mouse.wheel(0,850)
                    page.wait_for_timeout(1200)
                    page.screenshot(path=str(OUT/f'mimikko-scroll-{i}.png'))
        except Exception as e:
            print(name, str(e), flush=True)
    browser.close()
