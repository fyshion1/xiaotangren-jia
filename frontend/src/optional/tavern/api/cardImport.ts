// Optional feature contract and unavailable fallback; contains no feature implementation.
import type { CharacterProfile } from '../../../data/characters';
/** 抽取 / 翻译模型走聊天那一份上游（与 lib/visionRoute 同源）：留空则由后端回退 .env。 */
export type CardImportRoute = {
    baseUrl: string;
    apiKey: string;
    model: string;
};
export type CardPreview = {
    status: 'preview';
    filename: string;
    /** chara_card_v1 / v2 / v3 —— 用来在预览里标一句「这是哪个版本的卡」。 */
    spec: string;
    creator: string;
    tags: string[];
    /** 卡里有没有开场白。**存下来但不自动发言**：导入框默认不勾，勾了才写进私聊第一条。 */
    has_greeting: boolean;
    /** 草稿档案：键与 CharacterProfile 一致（缺 id / forms 等可选字段）。 */
    profile: Partial<CharacterProfile> & {
        imported?: boolean;
    };
    /** 非致命提醒（截断、没抽成、没卡图…）。有内容就在预览里摊开给用户看。 */
    warnings: string[];
    /** 同名角色已在库：前端先问「跳过还是新建第二张」，默认跳过。 */
    duplicates: {
        id: string;
        name: string;
    }[];
};
/**
 * 只读卡，**不建角色、也不叫模型** —— 毫秒级返回，立绘与「关于」立刻能看。
 *
 * 词条与译文由 `extractTavernCard` / `translateTavernCard` 后填，别在这里等。
 */
export function previewTavernCard(file: File): Promise<CardPreview>;
export function previewTavernCard(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }

/** 流式请求的进度回调。`token` 是模型新吐的一段字；`status` 是「正在重试 1/2」这类提示。 */
export type StreamHandlers = {
    onToken?: (text: string) => void;
    onStatus?: (message: string) => void;
    /** 最终结果（done 事件）。 */
    onDone?: (payload: Record<string, unknown>) => void;
    /** 失败（error 事件 / 断连 / HTTP 错误）—— **不致命**，拿来当提醒就行。 */
    onError?: (message: string, payload?: Record<string, unknown>) => void;
    signal?: AbortSignal;
};
/** 第二步：叫模型从原文里抽词条（**流式**）。抽不到就是空词条 + warnings，不抛。 */
export function extractTavernCardStream(file: File, route: CardImportRoute | undefined, h: StreamHandlers): Promise<void>;
export function extractTavernCardStream(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }

/** 第三步：要一份**只给界面看**的中文译文（流式）。翻的是传进来的 text（用户改过就翻改过的）。
 *  正文本来就是中文时后端直接跳过（`skipped: true`），一个 token 都不吐。 */
export function translateTavernCardStream(text: string, route: CardImportRoute | undefined, h: StreamHandlers): Promise<void>;
export function translateTavernCardStream(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }

/** 按（可能被用户改过的）草稿建角色。`id` 留空 = 新建第二张（后端生成 `char-<hex>`）。
 *  `greeting=true` 时后端把卡里的开场白写成她私聊的第一条 —— **默认 false，不写**。 */
export function commitTavernCard(body: {
    id?: string;
    name: string;
    fields: Partial<CharacterProfile> & {
        imported?: boolean;
    };
    /** 勾了「把卡里的开场白放进她的私聊」才传 true。 */
    greeting?: boolean;
}): Promise<CharacterProfile>;
export function commitTavernCard(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }

/** 角色介绍页的「插入开场白」：把档案里存的那份开场白写成她私聊的第一条。
 *  会话已经聊过则 409（开场白插到最新消息后面会很怪），把后端的原话抛给用户看 ——
 *  用户确认「还是要插」之后带 `insert: true` 再调一次。 */
export function insertTavernCardGreeting(charId: string, insert?: boolean): Promise<{
    ok: boolean;
    session_id: string;
    content: string;
}>;
export function insertTavernCardGreeting(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }

/** 删掉导入的角色卡（角色介绍 / 最近对话里都能点）。
 *  只有导入的卡删得掉 —— 自家四位是种子数据，后端会 400 并说明原因。 */
export function deleteTavernCard(charId: string, purge?: boolean): Promise<{
    ok: boolean;
    removed: {
        sessions: number;
        messages: number;
        memories: number;
        gallery: number;
        files: number;
    };
}>;
export function deleteTavernCard(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }
