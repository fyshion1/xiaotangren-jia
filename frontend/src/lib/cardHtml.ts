/** Only the iframe consumes this source. Never inject it into the application DOM. */
export function hasCardHtml(source: string): boolean {
  return /<\s*(?:!doctype|html|body|style|script|div|span|p|img|table|details|button|svg|h[1-6])\b/i.test(source)
}

export function cardDocument(source: string, interactive: boolean, options: {
  theme?: 'light' | 'dark'; characterName?: string
} = {}): string {
  let content = source.replace(/```(?:html)?\s*\n([\s\S]*?)```/gi, '$1')
  if (options.characterName) {
    const name = options.characterName.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]!)
    content = content.replace(/\{\{char\}\}/gi, () => name)
  }
  const dark = options.theme === 'dark'
  // An opaque sandbox origin prevents access to the host DOM, cookies and storage.
  // CSP also blocks API calls, subframes and forms. HTTPS libraries require opt-in.
  const policy = [
    "default-src 'none'", "base-uri 'none'", "form-action 'none'",
    "connect-src 'none'", "frame-src 'none'", "object-src 'none'",
    "img-src https: data:", "media-src https: data:", "font-src https: data:",
    "style-src 'unsafe-inline' https:",
    interactive ? "script-src 'unsafe-inline' https:" : "script-src 'none'",
  ].join('; ')
  return `<!doctype html><html><head><meta charset="utf-8">
    <meta http-equiv="Content-Security-Policy" content="${policy}">
    <meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>html{color-scheme:${dark ? 'dark' : 'light'};background:${dark ? '#20212a' : '#fff'};color:${dark ? '#eee' : '#222'};font:15px/1.6 system-ui,sans-serif}body{margin:0;padding:16px;overflow-wrap:anywhere}img,video,svg{max-width:100%}pre{white-space:pre-wrap}table{max-width:100%}</style>
    </head><body>${content}</body></html>`
}
