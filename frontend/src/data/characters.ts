// 角色资料模型。所有词条（含提示词）都存在后端 SQLite，可随时在前端编辑。
//
// 唯一真相源：仓库根目录《角色设定.md》→ backend/app/seed_characters.py（空库种子）。
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
  // 头部
  name: string
  jp: string // 日文假名
  alias: string // 别名 / 称号
  emoji: string // 暂代立绘的 emoji（日后换成 Live2D / 立绘图）
  portrait?: string // 静态立绘 / GIF 图片 URL（未填则用 emoji 占位）
  avatar?: string // 头像图片 URL：聊天气泡 / 会话列表用（未填则回退 emoji）
  // 提示词（喂给模型）
  about: string
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
}

/** 后端拉不到人设时的应急占位（正常路径见 api/client.ts 的 fetchCharacters）。 */
export const PROFILE_FALLBACK: CharacterProfile[] = [
  {
    // 大老大 = 用户本人（见 seed_characters.py 文件头 ⚠）。放在最前，介绍页第一张卡就是自己。
    id: 'dalaoda',
    name: '大老大',
    jp: 'ビッグボス',
    alias: '本家主人 · 小糖人们围着转的那个人',
    emoji: '🐻',
    about: '你是「大老大」，小糖人之家的主人 —— 这个家里唯一的人类。',
    birthday: '1 月 1 日',
    age: '秘密（被问会糊弄过去）',
    height: '照着镜子自己填',
    bloodType: '保密',
    constellation: '摩羯座',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '—',
    hip: '—',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '—',
    secret: '',
    weakPoint: '',
    privateWish: '',
    baseFormName: '第一形态 · 日常',
    relation: '你是小糖人之家的主人 —— 大诗音、小诗音、小白、小红薯头共同的主人。',
    asCharacter: true,
  },
  {
    id: 'dashiyin',
    name: '大诗音',
    jp: 'かほるずき しおん',
    alias: '大姐头 · 烘焙担当',
    emoji: '🌸',
    about: '你是「大诗音」，小糖人之家里的大姐头，22 岁。',
    birthday: '3 月 14 日',
    age: '22',
    height: '168cm',
    bloodType: 'A 型',
    constellation: '双鱼座',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '',
    hip: '',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '',
    secret: '',
    weakPoint: '',
    privateWish: '',
  },
  {
    id: 'xiaoshiyin',
    name: '小诗音',
    jp: 'コシオン',
    alias: '战术副官 · 纪律委员',
    emoji: '🎒',
    about: '你是「小诗音」，小糖人之家的战术副官，21 岁。',
    birthday: '8 月 22 日',
    age: '21',
    height: '150cm',
    bloodType: 'O 型',
    constellation: '狮子座',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '',
    hip: '',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '',
    secret: '',
    weakPoint: '',
    privateWish: '',
  },
  {
    id: 'xiaobai',
    name: '小白',
    jp: 'シロ',
    alias: '猫猫少女 · 治愈担当',
    emoji: '🐾',
    about: '你是「小白」，小糖人之家的治愈担当，20 岁。',
    birthday: '11 月 11 日',
    age: '20',
    height: '142cm',
    bloodType: 'AB 型',
    constellation: '天蝎座',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '',
    hip: '',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '',
    secret: '',
    weakPoint: '',
    privateWish: '',
  },
  {
    id: 'xiaohongshutou',
    name: '小红薯头',
    jp: 'ぐりぱん',
    alias: '吉祥物 · 打气担当',
    emoji: '🍠',
    about: '你是「小红薯头（千歌）」，小糖人之家的吉祥物（吉祥物设定，不计入实际年龄）。',
    birthday: '8 月 1 日',
    age: '吉祥物设定 · 不计入实际年龄',
    height: '35cm（挂件）/ 120cm（人形）',
    bloodType: 'B 型',
    constellation: '狮子座',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '「拉——批——！拉批拉批拉批！」',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '',
    hip: '',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '',
    secret: '',
    weakPoint: '',
    privateWish: '',
  },
]

/**
 * 私人空间（§22）的应急占位：后端拉不到 `GET /api/profiles` 时，至少让那一排身份卡片
 * 有东西可点（否则「私人空间」整页空白）。真正的档案内容在后端 `seed_profiles.py`，
 * 这里只放能认出来的最小信息 —— 别在第二处维护人设副本（见文件头）。
 */
export const PERSONA_FALLBACK: CharacterProfile[] = [
  {
    id: 'dalaoda',
    name: '大老大',
    jp: 'ビッグボス',
    alias: '本家主人 · 小糖人们围着转的那个人',
    emoji: '🐻',
    about: '你是「大老大」，小糖人之家的主人 —— 这个家里唯一的人类。',
    birthday: '1 月 1 日',
    age: '秘密（被问会糊弄过去）',
    height: '照着镜子自己填',
    bloodType: '保密',
    constellation: '摩羯座',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '—',
    hip: '—',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '—',
    secret: '',
    weakPoint: '',
    privateWish: '',
    relation: '你是小糖人之家的主人 —— 大诗音、小诗音、小白、小红薯头共同的主人。',
    asCharacter: true,
  },
  {
    id: 'xizi',
    name: '汐子',
    jp: 'しおこ / シオコ',
    alias: '大老大的性转独立体 · 家里新来的女孩',
    emoji: '🌊',
    about: '你是「汐子」，小糖人之家新来的女孩 —— 大老大分化出来的女性独立体。',
    birthday: '1 月 1 日',
    age: '秘密（被问会糊弄过去）',
    height: '比大老大矮一点点',
    bloodType: '保密',
    constellation: '摩羯座',
    personality: [],
    likes: [],
    dislikes: [],
    catchphrase: '',
    bodyType: '',
    eyeColor: '',
    hairstyle: '',
    hairColor: '',
    bust: '—',
    hip: '—',
    clothing: '',
    occupation: '',
    relationships: '',
    specialFeatures: '',
    weight: '',
    measurements: '—',
    secret: '',
    weakPoint: '',
    privateWish: '',
    relation: '你是「汐子」—— 大老大分化出来的女性独立体，和他同源、却以女生的身份独立存在。',
    // 她是**身份**不是角色：永远不进角色介绍 / 群聊阵容。
    asCharacter: false,
  },
]
