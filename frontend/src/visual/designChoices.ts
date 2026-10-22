// Approved visual variants, no experiment storage.
const approved = { invite: 'c2', header: 'h2', tools: 't2', topbar: 'w2', nest: 'n3' } as const
export const useDesignChoice = (group: keyof typeof approved): string => approved[group]
