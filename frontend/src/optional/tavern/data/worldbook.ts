// Optional feature contract and unavailable fallback; contains no feature implementation.
export type WorldbookEntry = {
    id: string;
    title: string;
    keywords: string;
    content: string;
    enabled: boolean;
    priority: number;
    /** 归属（§19）：'' = 家共用（群聊用），<角色 id> = 那位角色的专属 */
    owner: string;
    updated_at: string;
};
export function keywordList(entry: WorldbookEntry): string[];
export function keywordList(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }
