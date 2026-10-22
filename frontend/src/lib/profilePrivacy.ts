/** Display grouping only: keep stored profiles and model context intact. */
export const PRIVATE_PROFILE_FIELDS = new Set([
  'bodyType', 'bust', 'hip', 'weight', 'measurements', 'secret', 'weakPoint', 'privateWish',
])

export function isPrivateProfileField(key: string, label = '') {
  return PRIVATE_PROFILE_FIELDS.has(key) || /胸部|胸围|乳房|乳头|罩杯|臀部|臀围|三围|身体尺寸|私密|隐私|性癖|性器|生殖|阴部|阴道|阴茎|敏感部位|bust|breast|buttocks|genitals|fetish/i.test(label)
}
