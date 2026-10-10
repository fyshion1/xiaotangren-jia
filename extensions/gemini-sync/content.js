(() => {
  let lastPayload = "", busy = false, timer;
  const conversation = () => location.pathname.match(/^\/app\/([A-Za-z0-9_-]+)/)?.[1] || "";
  async function hash(text) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)); return [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, "0")).join("").slice(0, 24); }
  async function collect() {
    const nodes = [...document.querySelectorAll("user-query, model-response")].filter(n => n.getClientRects().length);
    const result = [], occurrences = new Map();
    let userKey = "", assistantIndex = 0;
    for (const node of nodes) {
      const role = node.tagName.toLowerCase() === "user-query" ? "user" : "assistant";
      const textNode = node.querySelector(role === "user" ? ".query-text, .user-query-content" : ".markdown, .model-response-text");
      if (!textNode) continue;
      const content = textNode.innerText?.trim();
      if (!content) continue;
      const nativeId = node.getAttribute("data-message-id") || node.id || node.closest("[data-turn-id]")?.getAttribute("data-turn-id");
      if (role === "user") {
        const h = await hash(content), count = (occurrences.get(h) || 0) + 1;
        occurrences.set(h, count); userKey = `${h}-${count}`; assistantIndex = 0;
      }
      // 无原生标识时，回答锚定用户文本，流式变长不会新增消息。
      if (role === "assistant" && !userKey && !nativeId) continue;
      const id = nativeId ? `${role}-${nativeId}` : role === "user" ? `user-${userKey}` : `assistant-${userKey}-${assistantIndex++}`;
      result.push({id, role, content, complete: false});
    }
    return result;
  }
  async function sync() {
    if (busy) return;
    busy = true;
    try {
      const c = await chrome.storage.local.get(["conversationId", "enabledTabId"]);
      const cid = conversation();
      if (!cid || c.conversationId !== cid || c.enabledTabId == null) return;
      const messages = await collect();
      if (!messages.length) { await chrome.storage.local.set({status: "未识别到文字消息；请打开已保存的会话，页面结构可能需要适配"}); return; }
      const payload = JSON.stringify(messages);
      if (payload === lastPayload) return;
      // 分批发送，防止长会话超过单次接口限制。
      for (let i = 0; i < messages.length; i += 50) {
        const result = await chrome.runtime.sendMessage({type: "sync", conversation_id: cid, messages: messages.slice(i, i + 50)});
        if (!result || result.error || result.paused) return;
      }
      lastPayload = payload;
    } catch { /* 扩展重载后旧脚本失效：刷新 Gemini 页面即可。 */ }
    finally { busy = false; }
  }
  new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(sync, 1500); }).observe(document.body, {subtree: true, childList: true, characterData: true});
  chrome.runtime.onMessage.addListener((m, sender, reply) => { if (m.type === "conversation") reply({conversationId: conversation()}); if (m.type === "start") { lastPayload = ""; void sync(); reply({ok: true}); } });
  setInterval(sync, 5000);
})();
