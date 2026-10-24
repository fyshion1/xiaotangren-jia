本功能由可选独立项目 `features/tavern` 提供，安装方式见[酒馆插件说明](tavern-feature.md)。

角色卡 HTML 预览支持导入框的“显示格式”、开场白原始排版、角色介绍页和已完成的助手消息。
打开预览不调用模型；翻译、抽词条仍需各自点击。

CSS、图片、表格、原生折叠元素在独立 iframe 内渲染。脚本默认关闭，勾选“启用卡内交互脚本”后可运行卡内脚本及 HTTPS 脚本库。外链素材需要联网，相对路径素材和依赖酒馆运行时的插件接口、变量系统、聊天命令尚不兼容。这里只实现 HTML 预览，不宣称完整复刻 SillyTavern 运行时。

卡内 extensions.regex_scripts 保存为 tavernRegexScripts。支持按顺序执行面向助手消息的显示替换（placement 2）、禁用标记、promptOnly 跳过、深度范围、JavaScript 正则 flags 和标准捕获组替换。宏正则和 trimStrings 暂不支持，会显示跳过提醒。规则仅在预览中执行，放在独立 Worker 内，2 秒超时终止，避免恶意回溯卡住页面；不改聊天原文或提示词。卡内 data-send 选项仅展示，不自动发送聊天。

预览支持深／浅底切换，以显示依赖宿主暗色文字的卡片，并在显示层替换 {{char}} 为角色名。其他酒馆变量没有模拟。

iframe 使用不带 allow-same-origin 的 sandbox；CSP 禁止 connect、子 frame、object 和表单提交。不给卡片传递 Key、宿主 storage 或应用 API。更换源码时重新关闭脚本；重置或关闭预览会销毁原 iframe。高度可放大，内容在 iframe 内滚动，不接收卡片提供的 postMessage 来操纵宿主页面。

about 原文继续保存。开场白新增 greetingSource 保存完整源码；原有 greeting 仍为纯文本，用于插入聊天和上下文，greetingHtml 继续保留为基础富文本回退。旧卡丢失的样式和脚本无法从清洗后的字段重建，需要重新导入。保存角色不会执行源码；只有打开预览才加载外链素材，只有主动启用脚本才运行交互。

验证命令（在 frontend 下运行，可通过 CHROME_PATH 指定 Chrome 可执行文件）：

```powershell
npm run test:card-html
npm run test:card-import
npm run build
```

浏览器测试覆盖 CSS/图片/折叠、默认禁止脚本、手动启用按钮交互、父页面及 storage 隔离、阻断 API 请求、预览重置和更换源码后重新关闭脚本。导入测试确认打开预览或切换格式都不触发模型，点击抽取和翻译各触发一个对应请求。

后端 test_card_import.py 验证 greetingSource 经预览和落库完整保留，且默认不写入聊天消息。

assets/酒馆角色卡 的实卡检查：南小鸟的 first_mes 含背景 GIF、图片和行内 CSS；其备用开场白没有 HTML。朝比奈花音的 first_mes 含场景、状态和选项标记，15 条显示规则中有 6 条匹配首条开场白，生成红金剧场主题和三个选项按钮。

`npm run test:card-assets` 读取这两张实际 PNG，在浏览器验证渲染和 Worker 超时，并生成 docs/card-preview-evidence/kanon.png、kotori.png。测试不写入真实角色库、不调用模型；南小鸟的外链图片实际联网加载，是否成功取决于素材站。
