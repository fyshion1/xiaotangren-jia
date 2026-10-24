// 角色资料模型。所有词条（含提示词）都存在后端 SQLite，可随时在前端编辑。
//
// 默认角色由可选主题提供，用户实际档案以后端 SQLite 为准。
// 本文件只保留类型 + 一个后端不可用时的应急兜底，不再维护第二份人设副本
// （否则改一处漏一处，会出现「种子已更新、界面还是旧人设」的漂移）。

/** 形态覆盖的词条范围：除身份字段（id / name）与形态自身字段外，全部可覆盖。 */
type FormFields = Partial<Omit<CharacterProfile, 'id' | 'name' | 'forms' | 'activeFormId' | 'baseFormName'>>

/**
 * 形态（§17）：一个人物可以有多套「形态」模板 —— 换形态 = 换掉外貌 / 性格 / 提示词等词条，
 * 但 **角色 id 不变**（否则会孤立 `single-<charId>` 的会话历史与以 char_id 为键的个人记忆）。
 *
 * 存储上：基础形态（现有那份档案）直接用顶层平铺字段，其余形态只存「覆盖项」，
 * 未出现的键自动沿用基础形态 —— 因此加形态不必复制整份档案，也不会出现两份数据打架。
 */
export type CharacterForm = {
  id: string
  name: string
  /** 对顶层词条的覆盖；基础形态恒为 {}。 */
  fields: FormFields
}

export const BASE_FORM_ID = 'base'

export type CharacterProfile = {
  id: string
  hiddenInProfiles?: boolean
  hiddenFields?: string[]
  customFields?: { label: string; value: string }[]
  signature?: string
  // 头部
  name: string
  jp: string // 兼容旧档案字段；界面优先显示 signature
  alias: string // 别名 / 称号
  emoji: string // 暂代立绘的 emoji（日后换成 Live2D / 立绘图）
  portrait?: string // 静态立绘 / GIF 图片 URL（未填则用 emoji 占位）
  avatar?: string // 头像图片 URL：聊天气泡 / 会话列表用（未填则回退 emoji）
  /**
   * 实机模型（§36）：填了才能把角色卡左上角的显示方式切到那一档。
   * `model` 是**素材清单里的 key**，不是文件路径 —— 路径由前端 `lib/live2dAssets.ts` /
   * `lib/vrmAssets.ts` 负责拼（素材放在仓库根 `assets/`，只在本机 dev server 里可取）。
   */
  live2d?: { model: string }
  vrm?: { model: string }
  // 提示词（喂给模型）
  about: string
  /** 「关于」的**中文译文，只给界面看**（导入的酒馆卡才有）。
   *  喂给模型的永远是 `about` 原文，一个字不动；这份只是摆着好读，一键能切回原文看。 */
  aboutZh?: string
  /** 「关于」的**排版版本**（导入时后端洗过的轻量 HTML：`<p> <b> <i> <br>`）。
   *  只给界面画格式用；文字跟 `about` 对不上（比如后来手改了原文）就忽略它。 */
  aboutHtml?: string
  /** 卡里的开场白（去标签后的纯文本，导入的酒馆卡才有）。
   *  **绝不自动发言**：导入时默认不勾选，不写进聊天记录；想用去角色介绍页点「插入开场白」。 */
  greeting?: string
  /** 开场白的**排版版本**（洗过的 HTML），只给预览画格式用；`greeting` 仍是插进聊天的那份纯文本。 */
  greetingHtml?: string
  /** 卡片开场白的完整 HTML 源码，仅供隔离预览；不直接注入页面、不喂给模型。 */
  greetingSource?: string
  /** 酒馆显示扩展；仅转换预览，不改聊天原文和提示词。 */
  tavernRegexScripts?: import('../lib/cardDisplay').CardDisplayRule[]
  // 基本词条
  birthday: string
  age: string
  height: string
  bloodType: string
  constellation: string
  personality: string[]
  likes: string[]
  dislikes: string[]
  catchphrase: string
  // 外貌
  bodyType: string
  eyeColor: string
  hairstyle: string
  hairColor: string
  bust: string
  hip: string
  // 其他
  clothing: string
  occupation: string
  relationships: string
  specialFeatures: string
  // 个人隐私词条
  weight: string
  measurements: string
  secret: string
  weakPoint: string
  privateWish: string
  // 形态（§17）：可选，缺省 = 只有基础形态、卡片不显示形态 chip
  baseFormName?: string // 基础形态的显示名（如「第一形态 · 粉发」），未填则用默认名
  forms?: CharacterForm[] // 其余形态（只存覆盖项）
  activeFormId?: string // 当前激活形态；缺省 = BASE_FORM_ID
  // ---- 个人档案（§22）专用：只有「私人空间」里的身份档案才带这两个字段 ----
  /** 这个身份**与在场小糖人们的关系**。组装 Prompt 时注入，替代写死的「哥哥/姐姐」。 */
  relation?: string
  /** 当你**不是**这个身份时，她要不要作为可聊角色出现在角色介绍 / 群聊默认阵容。 */
  asCharacter?: boolean
  // ---- 导入的角色卡专用 ----
  /** 从「酒馆角色卡」导入的（后端 commit 时置 true）。
   *  两个作用：① 默认**不进**「小糖人的家」群聊（别人的孩子先单独聊，想拉进群去成员面板勾）；
   *  ② 只有她能删 —— 自家四位是种子数据，删了会被下次启动补种回来。 */
  imported?: boolean
  /** Native declarative package provenance; independent of the tavern flag. */
  characterPackId?: string
}

export {PROFILE_FALLBACK, PERSONA_FALLBACK} from '#theme/characters'
