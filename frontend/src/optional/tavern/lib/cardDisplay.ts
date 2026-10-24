// Optional feature contract and unavailable fallback; contains no feature implementation.
export type CardDisplayRule = {
    scriptName?: string;
    findRegex?: string;
    replaceString?: string;
    disabled?: boolean;
    placement?: number[];
    promptOnly?: boolean;
    substituteRegex?: number;
    minDepth?: number | null;
    maxDepth?: number | null;
    trimStrings?: string[];
};
export type DisplayResult = {
    html: string;
    warnings: string[];
    applied: number;
};
/** Self-contained so the same function can execute inside a disposable Worker. */
export function transformCardDisplay(source: string, rules: CardDisplayRule[], depth?: number): DisplayResult;
export function transformCardDisplay(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }

/** Imported regexes must not be able to freeze the UI with catastrophic backtracking. */
export function renderCardDisplay(source: string, rules: CardDisplayRule[], depth: number, signal: AbortSignal): Promise<DisplayResult>;
export function renderCardDisplay(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }
