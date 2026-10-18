import sys,json,time
from pathlib import Path
sys.path.insert(0,r'C:\Users\32437\.codex\tmp\pet-review-py')
from playwright.sync_api import sync_playwright
OUT=Path(__file__).parent/'evidence'
variant='stabilized' if '--stabilized' in sys.argv else 'baseline'
if '--dpr2' in sys.argv: variant+='-dpr2'
if '--logical' in sys.argv: variant+='-logical'
if variant!='baseline':
 OUT=OUT/variant
 OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
 b=p.chromium.launch(channel='chrome',headless=True)
 page=b.new_page(viewport={'width':1100,'height':850},device_scale_factor=2 if '--dpr2' in sys.argv else 1)
 if '--stabilized' in sys.argv:
  def intercept(route):
   response=route.fetch()
   body=response.text().replace('model.scale.set(scale)', 'model.scale.set(model.scale.x * scale)')
   body=body.replace('model = loaded;', 'model = loaded; window.reviewModel = loaded;')
   if '--logical' in sys.argv:
    body=body.replace('built.renderer.width', 'built.screen.width').replace('built.renderer.height', 'built.screen.height')
   route.fulfill(response=response,body=body)
  page.route('**/src/components/Live2DModelView.tsx',intercept)
 errors=[]
 page.on('pageerror',lambda e:errors.append(str(e)))
 page.goto('http://localhost:5173',wait_until='domcontentloaded')
 page.wait_for_timeout(1000)
 page.evaluate('''async()=>{
 const React=(await import('/node_modules/.vite/deps/react.js')).default;
 const {createRoot}=(await import('/node_modules/.vite/deps/react-dom_client.js')).default;
 const {Live2DModelView}=await import('/src/components/Live2DModelView.tsx');
 const {VrmModelView}=await import('/src/components/VrmModelView.tsx');
 document.querySelector('#root').style.display='none';
 const style=document.createElement('style');style.textContent='body{margin:0;background:repeating-conic-gradient(#ddd 0% 25%,#fff 0% 50%) 0/32px 32px}#review{display:flex;gap:24px;padding:20px}';document.head.append(style);
 const host=document.createElement('div');host.id='review';document.body.append(host);
 window.review={React,Live2DModelView,VrmModelView,root:createRoot(host),errors:[]};
 window.showModels=(h=760)=>{let {React:R,root,Live2DModelView:L,VrmModelView:V}=window.review;
 root.render(R.createElement(R.Fragment,null,...[['Live2D Haru',L,'/assets/live2d/CubismSamples/Haru/Haru.model3.json'],['VRM Alicia',V,'/assets/models/vrm/AliciaSolid_vrm-0.51.vrm']].map(([name,C,url])=>R.createElement('div',{key:name,style:{width:'480px',height:h+'px',position:'relative',border:'1px solid #888'}},R.createElement('label',null,name),R.createElement(C,{url,className:'absolute inset-0',onError:e=>window.review.errors.push(e)})))))};
 window.showModels();
 }''')
 page.wait_for_timeout(5500)
 page.screenshot(path=str(OUT/'local-models-t0.png'))
 page.wait_for_timeout(1300)
 page.screenshot(path=str(OUT/'local-models-t1.png'))
 page.mouse.move(750,400);page.mouse.down();page.mouse.move(850,400,steps=12);page.mouse.up()
 page.screenshot(path=str(OUT/'local-models-drag.png'))
 page.evaluate('window.showModels(400)');page.wait_for_timeout(1000)
 page.screenshot(path=str(OUT/'local-models-small.png'))
 stats=page.evaluate('''()=>({canvases:[...document.querySelectorAll('#review canvas')].map(c=>({width:c.width,height:c.height,cssWidth:c.clientWidth,cssHeight:c.clientHeight})),errors:window.review.errors})''')
 stats['pageErrors']=errors
 if '--logical' in sys.argv:
  stats['interaction']=page.evaluate('''async()=>{let m=window.reviewModel;if(!m)return {error:'model probe unavailable'};const hits=[];for(let y=30;y<390;y+=20)for(let x=100;x<400;x+=20){let h=m.hitTest(x,y);if(h.length)hits.push({x,y,h})}const result={hitExamples:hits.slice(0,12),hitNames:[...new Set(hits.flatMap(x=>x.h))],motionGroups:Object.keys(m.internalModel.settings.motions||{}),hasFocus:typeof m.focus,hasExpression:typeof m.expression};m.focus(150,80);await m.expression('F01');return result}''')
  page.wait_for_timeout(700)
  page.screenshot(path=str(OUT/'local-expression.png'))
 samples=[]
 for i in range(12):
  page.wait_for_timeout(173)
  raw=page.locator('#review > div').first.screenshot()
  (OUT/f'haru-sample-{i:02d}.png').write_bytes(raw)
  samples.append({'i':i,'bytes':len(raw)})
 stats['haruScreenshotSamples']=samples
 stats['webglFrames']=page.evaluate('''async()=>{const c=document.querySelector('#review canvas'),gl=c.getContext('webgl2')||c.getContext('webgl');const out=[];for(let f=0;f<30;f++){await new Promise(requestAnimationFrame);let d=new Uint8Array(c.width*c.height*4);gl.readPixels(0,0,c.width,c.height,gl.RGBA,gl.UNSIGNED_BYTE,d);let n=0;for(let i=3;i<d.length;i+=4)if(d[i]>10)n++;out.push(n)}return out}''')
 (OUT/'local-models-results.json').write_text(json.dumps(stats,ensure_ascii=False,indent=2),encoding='utf8')
 print(json.dumps(stats,ensure_ascii=False),flush=True)
 b.close()
