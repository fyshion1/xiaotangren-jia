// Optional feature contract and unavailable fallback; contains no feature implementation.
import type { CharacterProfile } from '../../../data/characters';
/** 半截 / 整段抽取文本 → 能用的词条（键集合与后端一致，空的一概不填）。 */
export function parseExtracted(raw: string): Partial<CharacterProfile>;
export function parseExtracted(..._args: unknown[]): never { throw new Error('酒馆插件未安装') }
