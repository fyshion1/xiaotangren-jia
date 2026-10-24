// Optional feature contract and unavailable fallback; contains no feature implementation.
/**
 * 酒馆角色卡导入浮层（聊天 · 会话列表底部的「🎴 导入角色卡（酒馆）」）。
 *
 * **快慢分开**（用户实测后拍板）：读卡 + 拼「关于」是纯本地活儿（毫秒级），
 * 所有慢的都在「叫模型」上 —— 所以预览先出画面（立绘 / 名字 / 关于立刻能看），
 * 词条抽取与中文译文只在用户点击后发起流式请求，打开预览不调用模型。
 * **这两件事永远不挡导入** —— 词条没抽完 / 译文没翻完 / 直接失败，都只是少填一点。
 *
 * 三条铁规矩（都是用户拍板的）：
 * 1. **原文一字不改** —— 「关于」里的正文是原作者写的，原样进来，不洗、不删、不改。
 * 2. **开场白不自动发言** —— 卡里的 first_mes 去标签后**存进档案**，但默认不勾选、
 *    绝不自动塞进聊天记录；想用就在这里勾一下（或事后在角色介绍页点「插入开场白」）。
 * 3. **重名先问** —— 同名角色已在库时，默认「跳过」（不动），用户坚持才建第二张。
 *
 * 中文译文（`aboutZh`）**只给界面看**：喂给模型的永远是原文，一键能切回去。
 *
 * 只在这里改「名字 / 别名 / emoji / 关于」，其余抽出来的词条进来后去 ✎ 编辑资料改 ——
 * 那套编辑器本来就有，不在这里再铺一遍。
 */
import type { CharacterProfile } from '../../../data/characters';
import { type CardImportRoute } from '../api/cardImport';
type Props = {
    file: File;
    /** 抽词条 / 翻译文用哪份上游（传聊天那一份配置即可）；不传则由后端回退 .env。 */
    route?: CardImportRoute;
    onClose: () => void;
    /** 建好了：带上落库后的完整档案（含最终 id）。 */
    onImported: (char: CharacterProfile) => void;
};
export default function CardImportDialog({ file, route, onClose, onImported }: Props): import("react").JSX.Element;
export default function CardImportDialog(..._args: unknown[]): import('react').JSX.Element { return null as unknown as import('react').JSX.Element }

export {};
