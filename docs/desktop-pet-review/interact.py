import sys,json
from pathlib import Path
sys.path.insert(0,r'C:\Users\32437\.codex\tmp\pet-review-py')
from playwright.sync_api import sync_playwright
OUT=Path(__file__).parent/'evidence'
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True)
 page=b.new_page(viewport={'width':1440,'height':1000})
 page.goto('https://www.mimikko.cn/#/intro',wait_until='domcontentloaded')
 page.wait_for_timeout(1800)
 page.get_by_text('兽耳电脑版',exact=True).click()
 page.wait_for_timeout(2500)
 page.screenshot(path=str(OUT/'mimikko-pc-top.png'))
 print('PC',page.url,flush=True)
 (OUT/'mimikko-pc-dom.txt').write_text(page.locator('body').inner_text(),encoding='utf8')
 (OUT/'mimikko-pc-assets.json').write_text(json.dumps(page.evaluate('({images:[...document.images].map(x=>x.src),backgrounds:[...document.querySelectorAll("*")].map(x=>getComputedStyle(x).backgroundImage).filter(x=>x!=="none"),videos:[...document.querySelectorAll("video")].map(x=>({src:x.src,poster:x.poster}))})'),ensure_ascii=False,indent=2),encoding='utf8')
 for i in range(1,4):
  page.mouse.wheel(0,850);page.wait_for_timeout(900);page.screenshot(path=str(OUT/f'mimikko-pc-scroll-{i}.png'))
 page.goto('http://localhost:5173',wait_until='domcontentloaded')
 page.wait_for_timeout(2500)
 page.screenshot(path=str(OUT/'local-top.png'))
 (OUT/'local-dom.txt').write_text(page.locator('body').inner_text(),encoding='utf8')
 print('LOCAL',page.url,flush=True)
 page.goto('https://airi.moeru.ai/',wait_until='domcontentloaded')
 page.wait_for_timeout(2500)
 page.get_by_text('配置您自己的 AI 服务来源',exact=True).click()
 page.wait_for_timeout(1500)
 page.screenshot(path=str(OUT/'airi-provider.png'))
 (OUT/'airi-provider-dom.txt').write_text(page.locator('body').inner_text(),encoding='utf8')
 b.close()
