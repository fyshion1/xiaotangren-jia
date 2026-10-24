# 角色包：制作、预览与导入

2026-10-24：本体增加原生声明式角色包 v1，入口为设置 → 插件管理 → 角色包（`/#plugins`）。无需启用主题或酒馆插件。这里只处理角色资料与图片，不加载包内 Python、JavaScript、HTML、世界书或正则脚本。

## 用户数据边界

- ZIP 预览只校验并暂存，不创建角色；点击“确认导入”后才写入。
- 导入的角色存入用户数据库，图片复制到 `backend/data/assets/`，使用 `/api/assets/{sha256}/content`；原安装包或主题移走后仍能读取。
- 相同包 ID 与模板 ID 对应稳定档案 ID。再次安装或升级只添加缺少的角色，已有档案整体保留，包括提示词、图片和个人修改，不静默替换。
- 原生角色包采用独立来源标记，不使用受酒馆开关控制的旧 `imported` 标记；酒馆插件关闭或未安装时仍可显示、编辑和聊天。
- 同名不同 ID 的角色不会自动合并。旧主题种子角色与首次角色包导入的档案 ID 不同，会产生独立档案，预览会提示。
- 卸载只将包记录标记为已卸载；角色、素材、聊天和记忆保留。角色资料页的“移除角色档案”只移除该档案，也保留素材、聊天和记忆；重新导入恢复同一 ID，但已移除的个人档案修改不会自动恢复。
- 安装记录包含包 ID、版本、来源声明和导入关系；包声明的作者和授权文字不等于平台已核实授权。当前没有作者签名认证机制；SHA-256 验证文件一致性。

## 获取方式

1. 选择本机 ZIP → 预览 → 确认导入。
2. 本机 `features/<目录>/character-pack.zip` 自动出现在角色包区域，点击“预览角色包”。它是数据包，不需要以代码插件运行。
3. 配置 GitHub 发行目录后点击“下载并预览”。下载后验证 SHA-256、清单 ID 和版本，再进入相同确认流程。

**当前尚无公共中心市场、自动发现远端包、账号或评分系统。** 本轮整理的 `features/xiaotangren-characters/` 为本机预览样包：来自旧主题的 4 份种子模板和 6 张原图，不读取私人数据库；授权和正式署名待整理，未发布线上发行文件。该目录被主仓库忽略，需要单独管理或发布，不能假设新用户克隆本体后已有此包。

### 本机 GitHub 目录配置

在被 Git 忽略的 `backend/data/market-catalog.json` 写入列表。以下值是格式示例，必须换成真实发行地址、版本和 SHA-256 后才能下载：

```json
[
  {
    "kind": "character-pack",
    "id": "publisher.guide",
    "name": "向导角色包",
    "version": "1.0.0",
    "author": "作者署名",
    "license": "实际授权条款或说明",
    "description": "包内容简介",
    "url": "https://github.com/OWNER/REPO/releases/download/v1.0.0/character-pack.zip",
    "sha256": "替换为发行文件的64位小写SHA256"
  }
]
```

下载仅允许 HTTPS GitHub 及官方资源域名，逐次检查重定向和公网解析；UI 不能提交任意下载 URL。下载上限 64 MB，超时与校验失败会终止，不安装文件。联网测试使用模拟 HTTP 响应验证，不代表已经发布或验证了真实远端发行文件。

## 声明式 ZIP v1

根目录恰好包含 `manifest.json` 与已声明的 `assets/<sha256>.<扩展名>` 文件。清单编码 UTF-8：

```json
{
  "format": "character-pack",
  "format_version": 1,
  "id": "publisher.guide",
  "name": "向导角色包",
  "version": "1.0.0",
  "author": "作者署名",
  "license": "实际授权说明",
  "description": "一个不带图片的最小包",
  "characters": [{"id": "guide", "name": "向导", "about": "角色设定"}],
  "assets": {}
}
```

带图时 `assets` 是 SHA-256 到 `{ "path": "assets/<sha>.png", "sha256": "<sha>" }` 的映射。角色 `avatar`、`portrait` 及形态覆盖中的图片写 `asset:<sha>`。支持 PNG、JPEG（规范扩展名 jpg）、WebP 和 GIF；不接受外链或本机绝对路径。

支持本体档案的文本、列表、`customFields: [{label,value}]`、`forms: [{id,name,fields}]`；未知字段会拒绝。每包 1–32 个角色、最多 64 张图、100 个 ZIP 条目；单图 20 MB、4000 万像素，清单 1 MB，ZIP 64 MB、展开总量 96 MB。不接受重复/越界路径、加密条目、符号链接、未声明文件。当前不支持音色、模型或 Live2D；这些资源需要独立契约。

### 制作工具

先准备 `source.json`，采用相同清单字段，但 `assets` 为空，图片字段直接填相对文件路径，如 `images/avatar.png`。源图片必须在源清单所在目录内。然后在项目根目录运行：

```powershell
backend/.venv/Scripts/python.exe tools/build_character_pack.py path/to/source.json path/to/character-pack.zip
```

工具自动生成哈希、统一扩展名、重写资源引用并按导入校验器检查，输出发行 SHA-256。不覆盖已有输出文件。不读取用户数据库，也不导出私人编辑后的角色；源模板和用户私人档案是两层数据。

## 本地 API

以下接口均要求本地控制面访问校验和 `X-Exploration-Dashboard: 1`，不是已开放给远程第三方的公共写接口。

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/character-packs` | 安装/卸载记录与档案是否仍存在 |
| `GET /api/character-packs/catalog` | 本机包和已配置 GitHub 目录、校验错误 |
| `POST /api/character-packs/preview` | multipart 文件字段 `file`，返回预览 token |
| `POST /api/character-packs/catalog/{catalog_id}/preview` | 从指定目录项取包并预览 |
| `POST /api/character-packs/install` | JSON `{ "token": "..." }`，确认导入 |
| `POST /api/character-packs/{pack_id}/uninstall` | 卸载包记录，保留用户数据 |
| `DELETE /api/character-packs/characters/{character_id}` | 明确移除包创建的档案；保留图片、聊天、记忆及包来源关系 |

成功 JSON 含 `api_version: 1`；预览 token 一小时过期，成功导入后不能复用，暂存总量限制 256 MB。校验错误返回 422，下载连接失败返回 502，权限拒绝返回 403。
