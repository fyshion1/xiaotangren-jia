# 素材来源与许可记录（LICENSE.md）

> 本文件记录 `assets/` 下**一切非本人生成素材**的来源、许可、可做/不可做的事。
> **规则**：往 `assets/` 放任何下载来的素材，都必须在这里补一行；无来源、无许可的素材不入库。
> 建立日期：2026-10-03

---

## 一、许可一览（先看这张表）

| 目录 | 资产 | 来源 | 许可 | 可用于本原型 | 可再分发 |
|---|---|---|---|---|---|
| `assets/room/kenney_*` | 家具 / 食物 / 节日 3D 模型（GLB+FBX+OBJ，439 个 GLB） | Kenney.nl | **CC0 1.0** | ✅ 随意 | ✅ 随意 |
| `assets/models/vrm/VRM1_Constraint_Twist_Sample.vrm` | VRM 1.0 样例（含 SpringBone） | pixiv Inc. / three-vrm | **VRM 1.0 License**（见下） | ✅ | ✅ 允许 |
| `assets/models/fbx/SeedSan.fbx` | VRM 示例头像模型 | VRM Consortium / UniVRM | **MIT**（仓库级） | ✅ | ✅ 需保留版权声明 |
| `assets/live2d/CubismSamples/Hiyori` | Live2D 官方样例模型（含动作/表情/物理） | Live2D Inc. | **Free Material License**（严禁再分发） | ✅ 私人使用 | ❌ **禁止** |
| `assets/live2d/CubismSamples/Haru` | 同上（Haru，动作/表情最全） | Live2D Inc. | **Free Material License** | ✅ 私人使用 | ❌ **禁止** |
| `assets/models/vrm/AliciaSolid_vrm-0.51.vrm` | 完整人形 VRM（授权存疑，私人使用无碍，见 §二·5） | DWANGO / UniVRM | 仓库 MIT / 模型条款不明 | ✅ 私人使用 | ❌ 不对外交付 |

> **★ 本项目使用场景（2026-10-03 确认）**：**私人使用、非商用、不分发**。
> 因此"能否再分发"这一栏对本项目**不构成阻碍**——但**"不对外交付"仍是硬边界**：
> 凡标注 ❌ 的素材，只在本机使用，**不进入任何对外发布的产物**。

---

## 二、逐条详情

### 1. Kenney（CC0 1.0 Universal）— 房间家具主力

- **来源**：https://kenney.nl/assets/furniture-kit 、`/food-kit`、`/holiday-kit`
- **许可**：**CC0 1.0 Universal**（公有领域奉献）。作者 Kenney Vleugels。
- **条款摘要**：可商用、可修改、可再分发，**无需署名**（署名是礼貌而非义务）。
- **包内许可证文件**：`assets/room/LICENSE.Kenney.txt`（页面存档）、各 `kenney_*/License.txt`（包内原件）
- **含哪些**：
  - `kenney_furniture-kit`：140 个道具 —— 床（单人/双人/上下铺）、衣柜、书柜、沙发、椅子、桌子、电视柜、浴缸、地毯、植物、灯……
  - `kenney_food-kit`：烘焙/厨房道具 —— 面包、蛋糕、水果、瓶罐、碗盘、烤盘……
  - `kenney_holiday-kit`：节日小物（可当装饰）
- **格式**：GLB / FBX / OBJ（+ 家具另有 GLTF）。**Unity 直接用 GLB 或 FBX**。
- **已做的取舍**：删掉了 `furniture-kit` 的 DAE 与 STL 格式（3D 打印/遗留格式，占 6.6MB 且用不上），保留 GLB/FBX/OBJ 三套。
- **注意**：Kenney 是**低多边形（low-poly）卡通风格**，与大诗音二次元角色风格不统一。
  v1 原型阶段用来"把房间搭起来"够用；v2 追求统一质感时需要替换或重贴图（见 `docs/大诗音房间设计.md`）。

### 2. VRM1_Constraint_Twist_Sample.vrm（VRM 1.0 License）

- **来源**：https://github.com/pixiv/three-vrm → `packages/three-vrm/examples/models/`
- **许可**：模型内嵌 VRM 1.0 meta 明确声明：
  - `authors`: pixiv Inc. / `copyrightInformation`: (c) 2022 pixiv Inc.
  - `avatarPermission`: everyone ｜ `commercialUsage`: corporation
  - `modification`: **allowModificationRedistribution** ｜ `allowRedistribution`: **true**
  - `creditNotation`: unnecessary（不强制署名）
- **用途**：VRM 1.0 + SpringBone 的技术验证样例，**不是角色美术成品**（机械性测试模型）。
  价值：验证 UniVRM 导入 / VRM 1.0 解析 / SpringBone 物理是否正常工作。
- **仓库许可证**：MIT（`LICENSE.three-vrm.txt`）

### 3. SeedSan.fbx（MIT）

- **来源**：https://github.com/vrm-c/UniVRM → `Assets/VRM10_Samples/ModelSetup_SeedSan/Models/`
- **许可**：UniVRM 仓库 **MIT License**（`LICENSE.UniVRM.txt`，MIT 许可证全文）。
- **用途**：VRM 示例用的人形头像模型，用于验证"导入 FBX → 看到人形骨架"。
- **MIT 义务**：再分发时保留版权声明与许可证副本（已在同目录保留 `LICENSE.UniVRM.txt`）。

### 4. Hiyori / Haru（Live2D Free Material License）— ⚠️ 只能自用，禁止再分发

- **来源**：https://github.com/Live2D/CubismWebSamples → `Samples/Resources/{Hiyori,Haru}/`
- **许可**：**Live2D Free Material License**（`assets/live2d/LICENSE.CubismWebSamples.md`）
- **✅ 可以做**：
  - 个人/非商业使用、自由修改（做练习、做本地 Demo、调试 `pixi-live2d-display` / Unity Live2D 导入管线）
- **❌ 明确禁止**（Free Material License §4.1）：
  - **禁止再分发**（§4.1.1）—— **不能把模型文件放进《小糖人之家》仓库、不能上传公开仓库、不能随成品分发**
  - **禁止修改后当作自己的角色发布**（§4.1.2 不修改原角色身体比例做"改头换面"）
  - 禁止转售 / 转授权（§4.1.5）
- **额外义务**：年营收 ≥ 1000 万日元的商业实体使用时须签 Cubism SDK Release License。
  （本项目为个人自用/练习，**不触发**此条。）
- **✅ 本项目结论**：本项目为私人使用、非商用、不分发（2026-10-03 确认），
  **使用这两个模型完全合规**——可用于本地练习、调试管线、对照学习。
  唯一红线：**不随任何产物对外分发**。
- **下载内容**：Haru 22 文件（moc3 + 2 贴图 + 21 动作 + 8 表情 + 物理/姿势），Hiyori 17 文件（moc3 + 2 贴图 + 10 动作 + 物理/姿势）。

### 5. AliciaSolid_vrm-0.51.vrm — ✅ 已确认可用于本项目

- **来源**：https://github.com/vrm-c/UniVRM → `Tests/Models/Alicia_vrm-0.51/`
- **仓库许可证**：MIT（覆盖仓库代码与测试资源）
- **模型内嵌元数据**：`author` = © DWANGO Co., Ltd.，`licenseName` = `Other`，
  `otherLicenseUrl` = `https://3d.nicovideo.jp/alicia/rule.html`（该页面现已无法访问）
- **矛盾点**：仓库标称 MIT，但模型元数据指向 DWANGO 自有条款且该条款页面已失效。
- **本项目处理（2026-10-03 已确认）**：本项目为**私人使用、非商用、不分发**，
  上述矛盾**不构成本项目的风险**，因此**保留使用**。
- **使用边界（不变）**：仅本地使用；**不进入任何对外交付物**（《小糖人之家》若未来对外发布，
  须在此前替换为自产素材或 CC0 素材）。
- 商业分发场景下需重新评估，届时以 DWANGO 现行条款为准。

---

## 三、本项目采用的收录规则（后续新增素材请照此办）

1. **只下载许可明确的素材**，优先级：CC0 > MIT / Apache / CC-BY > 自定义 EULA（须逐条读）。
2. 每个来源都保留**许可证原文**，文件名写清来源仓库（如 `LICENSE.UniVRM.txt`）。
3. 在**本文件**补一行（表格 + 详情），写清：来源 URL、许可、能做什么、**不能做什么**。
4. **"免费下载" ≠ "可分发"**：Live2D 官方样例就是典型——能免费用，不能放进仓库。
5. 本项目场景是**私人使用/非商用/不分发**，所以"不可再分发"的素材**可以用**；
   但一律视为**仅本机**，并在文件头部显著标注 `⚠️ NON-REDISTRIBUTABLE - local use only`。
6. 若未来要对外交付/发布，**只能使用自产内容或 CC0 素材**，届时须逐个替换本文件标注 ❌ 的素材。

---

## 四、还没找到的素材（下一步）

| 需要的 | 现状 | 备选方案 |
|---|---|---|
| **适合当大诗音的完整人形 VRM** | ❌ 没有授权明确的高质量二次元人形 | ① 用 VRoid Studio 自己做（免费，导出 VRM，**授权完全自持**）<br>② 等 3D 线自产 |
| **烘焙角相关道具** | ✅ Kenney food-kit 已够用 | — |
| **日系房间素材（和室/洋室）** | 🟡 Kenney 偏欧美卡通 | 后续找 CC0 日系包，或 Blender 自建（用户有 Blender 基础） |
| **Quaternius 家具包** | ❌ 下载失败 | 作者放在 Google Drive，当前触发配额限制（"Too many users have downloaded"）。日后可重试：https://quaternius.com/packs/ultimatefurniture.html |