async function config() { return chrome.storage.local.get(["endpoint", "token", "enabledTabId", "conversationId", "status"]); }
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== "sync") return;
  (async () => {
    const c = await config();
    if (sender.tab?.id !== c.enabledTabId || message.conversation_id !== c.conversationId) return { paused: true };
    const url = new URL(c.endpoint || "http://127.0.0.1:8000");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "8000") throw new Error("仅允许本机 8000 端口");
    const response = await fetch(`${url.origin}/api/gemini-sync/messages`, {
      method: "POST", headers: {"Content-Type": "application/json", Authorization: `Bearer ${c.token || ""}`},
      body: JSON.stringify({conversation_id: message.conversation_id, messages: message.messages}), signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error(`同步失败 HTTP ${response.status}，请检查后端和配对凭证`);
    const result = await response.json();
    await chrome.storage.local.set({status: `已同步 ${message.messages.length} 条，${new Date().toLocaleTimeString()}`});
    return result;
  })().then(respond).catch(async e => { await chrome.storage.local.set({status: e.message}); respond({error: e.message}); });
  return true;
});
chrome.tabs.onRemoved.addListener(async tabId => { const c = await config(); if (c.enabledTabId === tabId) await chrome.storage.local.remove(["enabledTabId", "conversationId"]); });
chrome.runtime.onStartup.addListener(() => chrome.storage.local.remove(["enabledTabId", "conversationId"]));
