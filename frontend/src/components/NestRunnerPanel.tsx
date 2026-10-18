// 小窝 · 在小窝里把独立功能跑起来（§9.6）。
//
// 以前要自己开终端敲 `python -m scout run`，还得设 PYTHONIOENCODING，不然中文全是乱码
// （大老大原话：「在 vscs 的终端里跑好像跑不动，没有东西给我」）。现在在这里点一下就行：
//   选谁去看 → 选怎么跑 → 点按钮 → 日志就在下面滚动。
//
// 边界：前端只传「功能 id + 注册表里列出的子命令 + 白名单参数」，
// 真命令由后端按 features_registry.py 拼出（cwd 也锁在 features/<folder>/ 里）。
// 前端传不了任意命令、任意路径。
//
// 「派谁去看」的选项来自 `/api/characters`（= 角色介绍里那些人），
// **人设本体在大脑里**，这里只挑谁出门，不复制人设（复制就会漂移）。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  fetchCharacters,
  fetchNestDirective,
  fetchNestRunLog,
  fetchNestRunStatus,
  runNestFeature,
  saveNestDirective,
  stopNestFeature,
  type NestFeature,
  type NestRunnerCommand,
} from '../api/client'
import type { CharacterProfile } from '../data/characters'

type RunBody = Parameters<typeof runNestFeature>[1]

const POLL_MS = 3000
// 「主要看什么」的现成例子 —— 只是提示，不预填（预填会被当成「已经写过了」）。
const LOOK_FOR_HINTS = ['有趣的、搞笑的', '装机 / 硬件', 'AI 和效率工具', '饥荒 MOD', '科普纪录片']
const AVOID_HINTS = ['带货开箱', '直播回放', '太长的电影解说']

function whoSuffix(picked: string[], characters: CharacterProfile[]): string {
  if (picked.length === 0) return '按功能自己的默认口味'
  return picked
    .map((id) => characters.find((c) => c.id === id)?.name || id)
    .join('、')
}

export default function NestRunnerPanel({
  features,
  activeId,
  onActiveChange,
  bare = false,
}: {
  features: NestFeature[]
  activeId: string
  onActiveChange: (id: string) => void
  /** 由外面的抽屉提供卡片和标题（§9.6 布局改造）—— 内容照旧，只是不再自带外壳。 */
  bare?: boolean
}) {
  const runnable = features.filter((f) => f.runner && f.runner.commands.length > 0)
  const feature = runnable.find((f) => f.id === activeId) || runnable[0] || null

  const [characters, setCharacters] = useState<CharacterProfile[]>([])
  // 后端读不到时记一句（Block 二 ③）—— 以前静默 catch，页面就装成「一个角色都没有」/「没在跑」，
  // 跟真的空一模一样。运行状态和角色清单分开记：它们各自读各自的，别互相抹。
  const [offline, setOffline] = useState('')
  const [charErr, setCharErr] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [limit, setLimit] = useState(3)
  const [interval, setIntervalMin] = useState(30)
  const [memory, setMemory] = useState(false)
  const [busy, setBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [log, setLog] = useState('')
  const [note, setNote] = useState('')
  // 「主要看什么」：从后端读回大老大上次写的，改完立刻存（功能下轮就按它找）。
  const [lookFor, setLookFor] = useState('')
  const [avoid, setAvoid] = useState('')
  const [directiveSaved, setDirectiveSaved] = useState('')
  const logRef = useRef<HTMLPreElement | null>(null)

  const spec: NestRunnerCommand | null =
    feature?.runner?.commands.find((c) => c.name === command)
    || feature?.runner?.commands[0]
    || null

  useEffect(() => {
    // 角色清单读不到时别装成「一个角色都没有」（Block 二 ③）—— 那排 chip 会空着，
    // 看着像「这个家里没人」。记一句，下面说清楚。用独立的一个字段，免得被运行状态的
    // 成功读回顺手抹掉。
    void fetchCharacters().then((list) => { setCharacters(list); setCharErr('') })
      .catch((e) => { setCharacters([]); setCharErr(e instanceof Error ? e.message : String(e)) })
  }, [])

  // 换功能 → 换子命令 + 立刻看它是不是已经在跑（比如上次开了循环没关）。
  useEffect(() => {
    if (!feature) return
    const first = feature.runner?.commands[0]?.name || ''
    setCommand(first)
    setLog('')
    setNote('')
    setDirectiveSaved('')
    void fetchNestRunStatus(feature.id)
      .then((s) => { setRunning(s.running); setOffline('') })
      // 读不到运行状态时**保持上一次的显示**，不要把「在跑」闪成「没跑」——
      // 那会让人以为循环自己停了、又去点一次（Block 二 ③）。
      .catch((e) => setOffline(e instanceof Error ? e.message : String(e)))
    void fetchNestRunLog(feature.id, 200).then(setLog).catch(() => {})
    void fetchNestDirective(feature.id)
      .then((d) => { setLookFor(d.look_for); setAvoid(d.avoid) })
      .catch(() => { /* 口味读不到就留空，不影响启动 */ })
  }, [feature?.id])

  // 循环跑起来后，定期把日志尾巴拉过来滚（后端按 utf-8 读，中文不乱码）。
  useEffect(() => {
    if (!running || !feature) return
    const timer = window.setInterval(() => {
      // 同样是「读不到就别改显示」：轮询失败只是这一轮没拿到，不代表循环停了。
      void fetchNestRunStatus(feature.id).then((s) => { setRunning(s.running); setOffline('') }).catch(() => {})
      void fetchNestRunLog(feature.id).then(setLog).catch(() => {})
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, feature?.id])

  useEffect(() => {
    const box = logRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [log])

  const params = new Set(spec?.params || [])
  // 即时通讯类（QQ 桥）：一个账号只能演一个人，也没有「主要看什么」这个口味概念。
  const solo = feature?.kind === 'im'
  const lookLabel = solo ? '这次启动先演谁' : '选谁去看'
  const lookHint = solo
    // 设置跟着 QQ 桥搬进了它自己的面板（Block 二 ②），所以这里指路要指到那儿去。
    ? '一个 QQ 号 = 一个小糖人。平时在 QQ 桥面板里的「⚙ QQ 桥的设置 → 谁在 QQ 上」配「哪个号演谁」；' +
      '这里只临时覆盖第一个号（改完重启桥才换人）。当前：'
    : '人选来自角色介绍里的人；人设本身在大脑里，这里只决定谁出门。当前：'

  const run = useCallback(async () => {
    if (!feature || !spec || busy) return
    setBusy(true)
    setNote(spec.background ? '已丢到后台跑了，日志每几秒刷一次。' : '正在跑，等它跑完…')
    const body: RunBody = { command: spec.name }
    if (params.has('limit')) body.limit = limit
    if (params.has('interval')) body.interval = interval
    if (params.has('characters') && picked.length > 0) body.character_ids = picked
    if (params.has('memory')) body.memory = memory
    try {
      const result = await runNestFeature(feature.id, body)
      setRunning(result.running)
      setLog(result.output || (await fetchNestRunLog(feature.id)))
      setNote(result.running
        ? `已经在跑了（pid ${result.pid}）。想去掉谁、改间隔，先停再改。`
        : result.ok ? '跑完了 ✅ 看看下面 —— 有推东西的话，上面「小糖人找到了什么」会冒出来。'
          : `跑去出了点岔子（退出码 ${result.exit_code}），日志在下面。`)
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [feature?.id, spec?.name, busy, limit, interval, picked, memory, params])

  const saveDirective = useCallback(async () => {
    if (!feature) return
    try {
      const saved = await saveNestDirective(feature.id, lookFor.trim(), avoid.trim())
      setDirectiveSaved(`已存（${saved.updated_at}）—— ${feature.name}下一轮就按这个找`)
    } catch (e) {
      setDirectiveSaved(e instanceof Error ? e.message : String(e))
    }
  }, [feature?.id, lookFor, avoid])

  const stop = async () => {
    if (!feature || busy) return
    setBusy(true)
    try {
      const r = await stopNestFeature(feature.id)
      setRunning(false)
      setNote(r.stopped ? '停了，它回家啦。' : '本来就没在跑。')
      setLog(await fetchNestRunLog(feature.id))
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!feature || !spec) return null

  return (
    <section id={bare ? undefined : 'nest-runner-panel'}
      className={bare ? '' : 'mb-8 rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4'}>
      {!bare && (
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-[20px] font-extrabold tracking-wide">🚀 让功能跑起来</h2>
          <span className="text-[13px] text-[var(--text-3)]">
            本体只按一下启动键，逻辑都在 features/ 里那个独立项目
          </span>
        </div>
      )}

      {/* 读不到运行状态时说清楚（Block 二 ③）：下面显示的状态还是上一次读到的，
          不代表现在就是这样。不说的话「没跑」看着就跟真的一样。 */}
      {offline && (
        <p role="alert" className="mb-3 rounded-xl border border-[color-mix(in_srgb,var(--pink)_35%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[12px] text-[var(--pink-deep)]">
          ⚠ 读不到它的运行状态：{offline} —— 下面的「在跑 / 没跑」是上次读到的，不是现在。
        </p>
      )}

      {runnable.length === 0 ? (
        <p className="text-[13px] text-[var(--text-3)]">
          还没有能在小窝里直接跑起来的功能。（注册表里给功能配一条 <code>runner</code> 就会出现在这。）
        </p>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap gap-2">
            {runnable.map((f) => (
              <button key={f.id} className={`form-chip ${f.id === feature.id ? 'on' : ''}`}
                onClick={() => onActiveChange(f.id)}>
                {f.emoji} {f.name}
              </button>
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            {/* ---- 主要看什么（最高优先级的口味指引）----
                即时通讯类（QQ 桥）没有「看什么」这回事 —— 它只听人说话，所以这格不出现。 */}
            {!solo && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--pink)_28%,var(--border))] bg-[var(--surface)] p-3 lg:col-span-2">
              <div className="mb-1 flex flex-wrap items-baseline gap-2">
                <span className="text-[14px] font-bold text-[var(--text)]">🎯 主要看什么</span>
                <span className="text-[11px] text-[var(--text-3)]">
                  写在这里的比「猜你喜欢」管用 —— {feature.name} 每轮都来读一次，改了下一轮就生效
                </span>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className="eyebrow mb-0.5 block">想看什么</span>
                  <textarea className="input min-h-[64px] w-full" value={lookFor}
                    onChange={(e) => setLookFor(e.target.value)}
                    placeholder="逗号分隔，例如：有趣的、搞笑的，装机硬件，AI 工具" />
                  <span className="mt-1 flex flex-wrap gap-1">
                    {LOOK_FOR_HINTS.map((h) => (
                      <button key={h} type="button" className="form-chip text-[11px]"
                        onClick={() => setLookFor((v) => (v.trim() ? `${v.trim()}，${h}` : h))}>+{h}</button>
                    ))}
                  </span>
                </label>
                <label className="block">
                  <span className="eyebrow mb-0.5 block">别给我看什么</span>
                  <textarea className="input min-h-[64px] w-full" value={avoid}
                    onChange={(e) => setAvoid(e.target.value)}
                    placeholder="逗号分隔，例如：带货开箱，直播回放" />
                  <span className="mt-1 flex flex-wrap gap-1">
                    {AVOID_HINTS.map((h) => (
                      <button key={h} type="button" className="form-chip text-[11px]"
                        onClick={() => setAvoid((v) => (v.trim() ? `${v.trim()}，${h}` : h))}>+{h}</button>
                    ))}
                  </span>
                </label>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button className="btn sm" onClick={() => void saveDirective()}>存下来</button>
                {!lookFor.trim() && !avoid.trim() && (
                  <span className="text-[11px] text-[var(--text-3)]">
                    还没写 → 现在只有一份通用的「有用 / 好玩」默认口味（多收藏几个也会自己长）
                  </span>
                )}
                {directiveSaved && <span className="text-[11px] text-[var(--pink-deep)]">{directiveSaved}</span>}
              </div>
            </div>
            )}

            {/* ---- 怎么跑 ---- */}
            <div className="space-y-3">
              <div>
                <span className="eyebrow mb-1 block">{lookLabel}</span>
                <div className="flex flex-wrap gap-1.5">
                  {characters.map((c) => {
                    const on = picked.includes(c.id)
                    return (
                      <button key={c.id} className={`form-chip ${on ? 'on' : ''}`}
                        onClick={() => solo
                          ? setPicked(on ? [] : [c.id])
                          : setPicked(on ? picked.filter((x) => x !== c.id) : [...picked, c.id])}>
                        {c.emoji} {c.name}
                      </button>
                    )
                  })}
                  <button className="form-chip" onClick={() => setPicked([])}>
                    {solo ? '不指定（按它的配置）' : '清空（用默认口味）'}
                  </button>
                  {!solo && characters.length > 1 && (
                    <button className="form-chip"
                      onClick={() => setPicked(characters.map((c) => c.id))}>全选（都去看）</button>
                  )}
                </div>
                {/* 一个 chip 都没列出来时给一句人话（Block 二 ③）：不然这块只剩「清空」一个按钮，
                    看着像「这家一个人都没有」。 */}
                {characters.length === 0 && (
                  <p role="alert" className="mt-1 text-[11px] text-[var(--pink-deep)]">
                    {charErr ? `⚠ 角色清单没读到：${charErr}` : '还在读角色清单…'}
                    {' '}—— 不是「家里没人」，是这份清单没下来；下面仍可以按功能自己的默认口味跑。
                  </p>
                )}
                <p className="mt-1 text-[11px] text-[var(--text-3)]">
                  {lookHint}
                  <b className="text-[var(--text-2)]">
                    {solo ? (picked[0] ? whoSuffix(picked, characters) : '（配置里那个）') : whoSuffix(picked, characters)}
                  </b>
                  {!solo && picked.length > 1 && '（多位会轮流挑，各说各的）'}
                </p>
              </div>

              <div>
                <span className="eyebrow mb-1 block">怎么跑</span>
                <div className="flex flex-wrap gap-1.5">
                  {feature.runner?.commands.map((c) => (
                    <button key={c.name} className={`form-chip ${c.name === spec.name ? 'on' : ''}`}
                      title={c.desc} onClick={() => setCommand(c.name)}>{c.label}</button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-[var(--text-3)]">{spec.desc}</p>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                {params.has('limit') && (
                  <label className="block">
                    <span className="eyebrow mb-0.5 block">最多推几个</span>
                    <input className="input w-20" type="number" min={1} max={20} value={limit}
                      onChange={(e) => setLimit(Number(e.target.value) || 1)} />
                  </label>
                )}
                {params.has('interval') && (
                  <label className="block">
                    <span className="eyebrow mb-0.5 block">每轮间隔（分钟）</span>
                    <input className="input w-24" type="number" min={1} max={1440} value={interval}
                      onChange={(e) => setIntervalMin(Number(e.target.value) || 1)} />
                  </label>
                )}
                {params.has('memory') && (
                  <label className="flex items-center gap-2 pb-2 text-[12px] text-[var(--text-2)]">
                    <input type="checkbox" checked={memory} onChange={(e) => setMemory(e.target.checked)} />
                    把这轮经历记成记忆（隔离在 {feature.id}，不会漏进日常聊天）
                  </label>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button className="btn sm" disabled={busy || running} onClick={() => void run()}>
                  {busy && !running ? '跑着呢…' : spec.label}
                </button>
                {running && <button className="btn ghost sm" disabled={busy} onClick={() => void stop()}>停掉循环</button>}
                {running && <span className="text-[11px] text-[var(--text-3)]">循环中，日志每 {POLL_MS / 1000} 秒刷新</span>}
              </div>

              {note && (
                <div className="rounded-xl border border-[color-mix(in_srgb,var(--pink)_30%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[12px] text-[var(--pink-deep)]">
                  {note}
                </div>
              )}

              {/* 花钱提醒只对「真的每轮调模型」的那个功能说 —— QQ 桥的 run 是常驻接消息，不按次花钱。 */}
              {spec.name === 'run' && !spec.background && (
                <p className="text-[11px] text-[var(--text-3)]">
                  ⚠ 这一步会真的调大脑（花 token）。想先看挑得准不准，用「试跑」—— 它只抓取打分，不花钱。
                </p>
              )}
              {solo && (
                <p className="text-[11px] text-[var(--text-3)]">
                  先跑一次「自检」：它会告诉你白名单空不空、大脑通不通、要连几个号、每个号演谁 ——
                  出问题一眼能看出来。白名单 / 演谁 / 音色 / 表情包都在 QQ 桥面板下面的
                  「⚙ QQ 桥的设置」里改（不用去编辑 <code>features/qq-bridge/config.json</code>），改完不用重启。
                </p>
              )}
            </div>

            {/* ---- 输出 ---- */}
            <div>
              <div className="mb-1 flex items-center justify-between">
                <span className="eyebrow">输出</span>
                {/* 读日志失败说明白（Block 二 ③）：以前静默吞掉，点了「刷新」看不出发生了什么，
                    就以为「日志本来就是空的」。 */}
                <button className="btn ghost sm" onClick={() => {
                  void fetchNestRunLog(feature.id)
                    .then((t) => { setLog(t); setOffline('') })
                    .catch((e) => setOffline(e instanceof Error ? e.message : String(e)))
                }}>
                  刷新
                </button>
              </div>
              <pre ref={logRef}
                className="h-72 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] leading-relaxed text-[var(--text-2)]">
                {log || '（还没有输出 —— 点上面的按钮跑一次）'}
              </pre>
            </div>
          </div>
        </>
      )}
    </section>
  )
}