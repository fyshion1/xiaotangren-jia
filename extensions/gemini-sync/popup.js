const endpoint = document.getElementById("endpoint"), token = document.getElementById("token"), status = document.getElementById("status");
chrome.storage.local.get(["endpoint", "token", "status"]).then(c => { endpoint.value = c.endpoint || endpoint.value; token.value = c.token || ""; status.textContent = c.status || "尚未开启"; });
document.getElementById("start").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (!tab?.url?.startsWith("https://gemini.google.com/")) throw new Error("请先切到 Gemini 网页");
    if (!token.value.trim()) throw new Error("请先填写本地同步凭证");
    const url = new URL(endpoint.value);
    if (!/^http:$/.test(url.protocol) || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== "8000") throw new Error("地址必须为本机 http://127.0.0.1:8000 或 localhost:8000");
    const info = await chrome.tabs.sendMessage(tab.id, {type: "conversation"});
    if (!info?.conversationId) throw new Error("请打开有 /app/会话ID 的已保存 Gemini 会话");
    await chrome.storage.local.set({endpoint: url.origin, token: token.value.trim(), enabledTabId: tab.id, conversationId: info.conversationId, status: "已开启，等待同步"});
    await chrome.tabs.sendMessage(tab.id, {type: "start"}); status.textContent = "已开启，打开小糖人的 test · Gemini 会话查看";
  } catch (e) { status.textContent = e.message; }
};
document.getElementById("stop").onclick = async () => { await chrome.storage.local.remove(["enabledTabId", "conversationId"]); await chrome.storage.local.set({status: "已停止"}); status.textContent = "已停止"; };
chrome.storage.onChanged.addListener(changes => { if (changes.status) status.textContent = changes.status.newValue; });
