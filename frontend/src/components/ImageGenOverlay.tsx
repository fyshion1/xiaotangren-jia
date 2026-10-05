// 生图浮层（§7）：从 ChatView 抽出的独立组件。
// 四个引擎（本地/云端 ComfyUI、第三方 API、NovelAI）的切换、参数设置、外观提示词拼装、
// 出图结果展示与「存入画廊」全在这里，ChatView 只管打开/关闭。
//
// 设计约束：
//   - 低耦合：只通过 props 接收所需的 session/config/回调，不直接读 ChatView 内部状态。
//   - 高鲁棒性：生成失败、后端未连接、第三方缺配置都有兜底 UI。
//   - 高扩展性：新增生图引擎只需在 fetchImageEngines 的内置表里加一条，这里自动展示。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CharacterProfile } from '../data/characters'
import type { ChatSession } from '../data/chats'
import { activeFormId, listForms } from '../lib/forms'
import { buildAppearancePrompt, formKey } from '../lib/comfyPrompt'
import { ownerOf } from '../lib/owner'
import { starImage } from '../api/gallery'
import {
  fetchImageEngines,
  generateImages,
  selectImageEngine,
  type GeneratedImage,
  type ImageEngine,
} from '../api/imagegen'
import {
  attachmentStats,
  clearOriginals,
  type AttachmentStats,
} from '../api/storage'
import type { ModelConfig } from './ChatView'

// Field 在 ChatView/JailbreakPanel/WorldbookPanel 里各有一份一样的；
// 生图浮层只需要简单 label+children 包裹，继续这份复制粘贴传统。
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="eyebrow mb-0.5 block">{label}</span>
      {children}
    </label>
  )
}

type Props = {
  open: boolean
  onClose: () => void
  session: ChatSession | undefined
  sessionKey: string
  visibleCharacters: CharacterProfile[]
  config: ModelConfig
  setLightbox: (url: string | null) => void
  setErrorText: (msg: string) => void
  setGalleryOpen: (v: boolean) => void
}

export default function ImageGenOverlay({
  open,
  onClose,
  session,
  sessionKey,
  visibleCharacters,
  config,
  setLightbox,
  setErrorText,
  setGalleryOpen,
}: Props) {
  const [genPrompt, setGenPrompt] = useState('')
  const [genBusy, setGenBusy] = useState(false)
  const [genImages, setGenImages] = useState<GeneratedImage[]>([])
  // 生图参数：尺寸 / 张数 / 负向 / 步数 / CFG / seed。留空 = 交给工作流自带的值。
  // 张数上限 4 —— ComfyUI 对同一 seed+prompt 返回同一张图，批量得逐个改 seed 重跑（见 services/comfyui.py）。
  const [genSize, setGenSize] = useState('512x768')
  const [genN, setGenN] = useState(1)
  const [genNegative, setGenNegative] = useState('')
  const [genSteps, setGenSteps] = useState('')
  const [genCfg, setGenCfg] = useState('')
  const [genSeed, setGenSeed] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  // 外观提示词拼装（§7）：从当前形态取外貌词条自动填进提示词框。
  // dirtyKeyRef 是脏跟踪键 `${charId}:${formId}` —— 换角色/换形态才重拼，
  // 否则用户手改的内容会被覆盖（§16.10：兜底要按字段做）。
  const [autoAppend, setAutoAppend] = useState(true)
  const [appearForm, setAppearForm] = useState('')
  const dirtyKeyRef = useRef('')
  const lastAutoRef = useRef('')
  // 生图方式切换器（§7）：四个插槽。默认 local；具体哪个可用由后端探测决定（ready）。
  const [enginesList, setEnginesList] = useState<ImageEngine[]>([])
  const [genEngine, setGenEngine] = useState('local')
  const [stats, setStats] = useState<AttachmentStats | null>(null)

  // 打开生图浮层时刷新一次本地存储统计（原图/缩略图各占多少）
  useEffect(() => {
    if (!open) return
    void attachmentStats().then(setStats)
  }, [open])

  // 打开生图浮层时拉一次生图方式列表（§7）；后端没起来就用内置表兜底
  useEffect(() => {
    if (!open) return
    void fetchImageEngines().then(({ engines, selected }) => {
      setEnginesList(engines)
      setGenEngine(selected)
    })
  }, [open])

  // 生图浮层打开时，按「在场的第一位角色 + 她的当前形态」拼装外观提示词。
  // 群聊取第一位：真要画别人，改提示词框里的名字比换角色更省事。
  useEffect(() => {
    if (!open || !autoAppend || !session) return
    const char = visibleCharacters.find((c) => c.id === session.characterIds[0])
    if (!char) {
      setAppearForm('')
      return
    }
    const key = formKey(char.id, activeFormId(char))
    setAppearForm(listForms(char).find((f) => f.id === activeFormId(char))?.name ?? '')
    if (dirtyKeyRef.current === key) return // 键没变 → 用户手改的内容一个字都不动
    const appearance = buildAppearancePrompt(char)
    if (appearance) {
      // 换角色/换形态要重拼，但只在「框里还是上一次自动拼的内容（或空的）」时才覆盖，
      // 用户自己写的东西留着 —— 想回到自动拼的版本可以点「↺ 重置」。
      setGenPrompt((prev) => (prev.trim() && prev !== lastAutoRef.current ? prev : appearance))
      lastAutoRef.current = appearance
    }
    dirtyKeyRef.current = key
  }, [open, autoAppend, session, visibleCharacters])

  const doGenerate = useCallback(async () => {
    const prompt = genPrompt.trim()
    if (!prompt || genBusy) return
    setGenBusy(true)
    setGenImages([])
    setErrorText('')
    // 数字框留空就别传，让工作流自带的步数/CFG/随机 seed 生效
    const num = (v: string) => (v.trim() ? Number(v) : null)
    try {
      const imgs = await generateImages({
        prompt,
        session_id: sessionKey || 'single-default', // 落在当前会话的附件目录里
        size: genSize,
        n: genN,
        seed: num(genSeed),
        negative: genNegative.trim(),
        steps: num(genSteps),
        cfg: num(genCfg),
        // thirdparty 才用得上：走「模型设置」里的生图覆盖；其余引擎后端不看这三个字段
        base_url: config.imageBaseUrl || (config.imageModel ? config.baseUrl : ''),
        api_key: config.apiKey,
        model: config.imageModel,
      })
      if (!imgs.length) throw new Error('生图接口返回为空')
      setGenImages(imgs)
    } catch (e) {
      setErrorText(e instanceof Error ? e.message : String(e))
    } finally {
      setGenBusy(false)
    }
  }, [genPrompt, genBusy, sessionKey, genSize, genN, genSeed, genNegative, genSteps, genCfg, config, setErrorText])

  // 生图结果「⭐ 存入画廊」：图已经在附件库里了（§7 生图直接落盘），
  // 这里只是把它登记进画廊 / 照片记忆，和聊天图片走的是同一个 starImage。
  const starGenerated = useCallback(
    async (g: GeneratedImage) => {
      if (!session) return
      setErrorText('')
      try {
        await starImage({
          orig: g.orig,
          session_id: sessionKey,
          message_id: '',
          owner: ownerOf(session),
          in_memory: true,
        })
        setGalleryOpen(true) // 顺手打开画廊，提示补一句描述
      } catch (e) {
        setErrorText(e instanceof Error ? e.message : String(e))
      }
    },
    [session, sessionKey, setErrorText, setGalleryOpen],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 backdrop-blur-sm" onClick={() => !genBusy && onClose()}>
      <div
        className="my-6 w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-5 shadow-[var(--shadow)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[16px] font-bold">🎨 生成照片</h3>
          <button onClick={() => !genBusy && onClose()} className="text-[var(--text-3)] hover:text-[var(--text)]">✕</button>
        </div>

        {/* 生图方式切换器（§7）：本地 ComfyUI / 云端 ComfyUI / 第三方 API / NovelAI（插槽） */}
        <div className="mb-3">
          <span className="eyebrow mb-1.5 block">选生图方式</span>
          <div className="flex flex-wrap gap-1.5">
            {enginesList.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => {
                  setGenEngine(e.id)
                  void selectImageEngine(e.id).catch((err) =>
                    setErrorText(err instanceof Error ? err.message : String(err)),
                  )
                }}
                title={e.desc}
                className={`rounded-lg border px-2.5 py-1 text-[12px] transition ${
                  genEngine === e.id
                    ? 'border-[var(--pink)] bg-[var(--pink-soft)] text-[var(--pink-deep)]'
                    : 'border-[var(--border-strong)] bg-[var(--surface-2)] text-[var(--text-2)] hover:border-[var(--pink)]'
                }`}
              >
                {e.name}
                {!e.ready && <span className="ml-1 text-[10px] text-[var(--text-3)]">未接入</span>}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] leading-snug text-[var(--text-3)]">
            {enginesList.find((e) => e.id === genEngine)?.desc ?? '生图方式加载中…'}
          </p>
        </div>

        <Field label="画面描述（提示词）">
          <div className="flex items-start gap-2">
            <textarea
              className="textarea flex-1"
              rows={3}
              value={genPrompt}
              onChange={(e) => setGenPrompt(e.target.value)}
              placeholder="如：大诗音穿着围裙在烘焙坊微笑着递上一块蛋糕…"
            />
            <button
              type="button"
              className="btn ghost sm shrink-0"
              title="按当前角色的形态重设为外貌提示词"
              disabled={!appearForm || !session}
              onClick={() => {
                const char = visibleCharacters.find((c) => c.id === session?.characterIds[0])
                if (!char) return
                const appearance = buildAppearancePrompt(char)
                if (!appearance) return
                setGenPrompt(appearance)
                lastAutoRef.current = appearance
              }}
            >
              ↺ 重置
            </button>
          </div>
        </Field>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <label className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--text-2)]">
            <input
              type="checkbox"
              checked={autoAppend}
              onChange={(e) => setAutoAppend(e.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--pink)]"
            />
            自动拼装外貌
          </label>
          <span className="text-[11px] text-[var(--text-3)]">
            {appearForm ? `按「${appearForm}」的外观` : '当前会话没有可用的角色'}
          </span>
        </div>

        {/* 参数区：尺寸 / 张数常显；负向提示词、步数、CFG、seed 收在「更多」里 */}
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-3)]">尺寸</span>
            <select className="input w-auto py-1 text-[12px]" value={genSize} onChange={(e) => setGenSize(e.target.value)}>
              <option value="512x768">512×768（SD1.5 竖）</option>
              <option value="768x512">768×512（SD1.5 横）</option>
              <option value="512x512">512×512（SD1.5 方）</option>
              <option value="832x1216">832×1216（SDXL 竖）</option>
              <option value="1216x832">1216×832（SDXL 横）</option>
              <option value="1024x1024">1024×1024（SDXL 方）</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-[var(--text-3)]">张数</span>
            <input
              type="number"
              min={1}
              max={4}
              className="input w-[70px] py-1 text-[12px]"
              value={genN}
              onChange={(e) => setGenN(Math.max(1, Math.min(4, Number(e.target.value) || 1)))}
            />
          </label>
          <button
            type="button"
            className="btn ghost sm"
            onClick={() => setShowAdvanced((v) => !v)}
            title="负向提示词 / 步数 / CFG / seed"
          >
            {showAdvanced ? '收起参数 ▴' : '更多参数 ▾'}
          </button>
        </div>

        {showAdvanced && (
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="flex flex-col gap-1 sm:col-span-3">
              <span className="text-[11px] text-[var(--text-3)]">负向提示词（不想出现的）</span>
              <input
                className="input py-1 text-[12px]"
                value={genNegative}
                onChange={(e) => setGenNegative(e.target.value)}
                placeholder="如：lowres, bad anatomy, extra fingers"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-3)]">步数（留空=工作流默认）</span>
              <input
                type="number"
                min={1}
                max={150}
                className="input py-1 text-[12px]"
                value={genSteps}
                onChange={(e) => setGenSteps(e.target.value)}
                placeholder="25"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-3)]">CFG（留空=工作流默认）</span>
              <input
                type="number"
                step="0.5"
                min={0}
                className="input py-1 text-[12px]"
                value={genCfg}
                onChange={(e) => setGenCfg(e.target.value)}
                placeholder="7.0"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-[var(--text-3)]">seed（留空=随机）</span>
              <input
                type="number"
                className="input py-1 text-[12px]"
                value={genSeed}
                onChange={(e) => setGenSeed(e.target.value)}
                placeholder="随机"
              />
            </label>
          </div>
        )}

        {genEngine === 'thirdparty' && !config.imageModel && (
          <p className="mt-2 rounded-lg bg-[var(--pink-soft)] px-3 py-2 text-[12px] leading-snug text-[var(--pink-deep)]">
            ⚠ 第三方通道还没配生图模型。请点 ⚙ 模型设置填一个支持 /images/generations
            的中转地址 + 模型名（vsllm 无生图通道）。
          </p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2.5">
          <span className="text-[11px] leading-snug text-[var(--text-3)]">
            {stats
              ? `本地：原图 ${(stats.orig_bytes / 1024 / 1024).toFixed(1)} MB · 缩略图 ${(stats.thumb_bytes / 1024).toFixed(0)} KB`
              : '存储统计加载中…'}
          </span>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="btn ghost sm"
              disabled={!stats?.orig_bytes}
              title="清掉本地原图，只留缩略图（省空间；想看高清再重新生成/发送）"
              onClick={() => void clearOriginals().then(() => attachmentStats().then(setStats))}
            >
              清理原图
            </button>
            <button className="btn ghost sm" onClick={() => !genBusy && onClose()}>取消</button>
            <button className="btn sm" onClick={doGenerate} disabled={genBusy || !genPrompt.trim()}>
              {genBusy ? '生成中…' : '生成'}
            </button>
          </div>
        </div>
        {genImages.length > 0 && (
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {genImages.map((g, i) => {
              const src = g.orig || g.thumb
              return (
                <figure key={g.id || i} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-2)]">
                  <img
                    src={src}
                    alt={`生成结果 ${i + 1}`}
                    className="w-full cursor-zoom-in"
                    onClick={() => setLightbox(src)}
                  />
                  <figcaption className="flex items-center justify-between gap-2 px-2 py-1.5">
                    <span className="text-[11px] text-[var(--text-3)]">结果 {i + 1}</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        className="btn ghost sm"
                        title="下载原图"
                        onClick={() => {
                          const a = document.createElement('a')
                          a.href = src
                          a.download = `xiaotangren-${i + 1}.png`
                          a.click()
                        }}
                      >
                        ⤓
                      </button>
                      <button
                        type="button"
                        className="btn ghost sm"
                        title="存入画廊（相册 + 照片记忆）"
                        onClick={() => void starGenerated(g)}
                      >
                        ⭐
                      </button>
                    </div>
                  </figcaption>
                </figure>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}