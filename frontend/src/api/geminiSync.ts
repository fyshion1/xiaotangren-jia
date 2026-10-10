export async function fetchGeminiPairing(): Promise<{ token: string; session_id: string }> {
  const response = await fetch('/api/gemini-sync/pairing')
  if (!response.ok) throw new Error(`获取本地同步凭证失败（HTTP ${response.status}）`)
  return response.json()
}
