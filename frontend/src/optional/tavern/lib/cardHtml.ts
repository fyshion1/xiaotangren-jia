// Optional feature contract and unavailable fallback; contains no feature implementation.
/** Only the iframe consumes this source. Never inject it into the application DOM. */
export function hasCardHtml(source: string): boolean;
export function hasCardHtml(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }

export function cardDocument(source: string, interactive: boolean, options?: {
    theme?: 'light' | 'dark';
    characterName?: string;
}): string;
export function cardDocument(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }
