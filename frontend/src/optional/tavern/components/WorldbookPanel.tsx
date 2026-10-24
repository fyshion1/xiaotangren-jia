// Optional feature contract and unavailable fallback; contains no feature implementation.
type Props = {
    /**
     * 这一页只管哪个归属的世界书（§19）：角色介绍页传 <charId>，糖人小窝传 ''（家共用）。
     * 新词条的归属固定 = 这个值，面板里不给下拉 —— 跟画廊「归属由所在页面决定」一个道理。
     */
    owner: string;
    /** 归属名字，只用于文案（如「大诗音的世界书」/「家 · 共用世界书」）。 */
    ownerLabel: string;
    /** 由外面的抽屉提供标题（§9.6 布局改造）—— 内容照旧，只是不再自带标题行。 */
    bare?: boolean;
};
export default function WorldbookPanel({ owner, ownerLabel, bare }: Props): import("react").JSX.Element;
export default function WorldbookPanel(..._args: unknown[]): import('react').JSX.Element { return null as unknown as import('react').JSX.Element }

export {};
