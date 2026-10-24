import type { WorldbookEntry } from '../../../data/worldbook'
function unavailable(): never { throw new Error('酒馆插件未安装') }
export async function fetchWorldbook(_owner?: string): Promise<WorldbookEntry[]> { return unavailable() }
export async function createWorldbookEntry(_entry: Omit<WorldbookEntry, 'id' | 'updated_at'>): Promise<WorldbookEntry> { return unavailable() }
export async function updateWorldbookEntry(_entry: WorldbookEntry): Promise<WorldbookEntry> { return unavailable() }
export async function deleteWorldbookEntry(_id: string): Promise<void> { return unavailable() }
