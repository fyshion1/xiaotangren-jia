// 小窝 · QQ 桥的专属面板。
//
// 为什么单独做一个面板：QQ 桥要连的是**外面一个网关**（SnowLuma，端口 3001）。
// 以前网关卡没开的时候，桥只会每 5 秒报一句「Cannot connect to host 127.0.0.1:3001」，
// 大老大得自己去 D:\SnowLuma 双击 launcher、再回小窝点启动 —— 两处来回跑。
// 现在这里一屏看完：
//   ① 网关在线没有（后端只探端口，很便宜）；
//   ② 没开 → 「⚡ 开 QQ 网关」一键把 SnowLuma 起起来（后端会等 3001 真的在听才回话）；
//   ③ 网关好了 → 顺手把桥也起起来（账号对得上的时候）；
//   ④ 网关挂的是哪个 QQ 号，不对就**自动换**给机器人号。
//
// ── 关于④（同时登两个号的那个坑，摸出来的）────────────────────────────────
// SnowLuma 不自己登录，是注入进**已经在跑的 QQ 进程**；每个号存一份配置
// `config/onebot_<号>.json`，而两份配置写死同一对端口（http 3000 / ws 3001）。
// 所以两个号都登着时会**抢**：先被挂上的赢，另一个 EADDRINUSE 变 degraded。
// 赢的多半是大号 —— 桥连上去一切正常，说话的身份却是错的。
// SnowLuma 没有任何参数能指定「只挂某个号」，只能从它的 WebUI API 下手：
// 把抢到端口的**别的号** unload 掉，再把机器人号的配置原样存一遍（只有存配置才会重新绑端口）。
// 这需要 WebUI 密码 —— 在**本面板最下面「⚙ QQ 桥的设置」→ 接入方式 → 网关网页密码**里填。
// 填了后端就会在开网关时自动换；没换成功可以点面板上的「↻ 换给机器人号」再来一次。
//
// 桥本身仍然是独立项目，这里只调通用的 /api/nest/*（跑 / 停 / 日志 / 网关）。
//
// 上面这些是**摸出来的**，完整版记在 docs/qq-gateway-snowluma.md（改这条线之前先读它）。

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  claimNestGateway,
  fetchNestGatewayStatus,
  fetchNestRunLog,
  fetchNestRunStatus,
  runNestFeature,
  startNestGateway,
  stopNestFeature,
  stopNestGateway,
  type NestGatewayStatus,
} from '../api/client'
import NestSettingsPanel from './NestSettingsPanel'

const FEATURE_ID = 'qq_bridge'
const GATEWAY_POLL_MS = 4000
const RUN_POLL_MS = 3000

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export default function QqBridgePanel() {
  const [gateway, setGateway] = useState<NestGatewayStatus | null>(null)
  const [gatewayBusy, setGatewayBusy] = useState(false)
  const [running, setRunning] = useState(false)
  const [bridgeBusy, setBridgeBusy] = useState(false)
  const [note, setNote] = useState('')
  const [log, setLog] = useState('')
  const logRef = useRef<HTMLPreElement | null>(null)

  const refreshGateway = useCallback(async (): Promise<NestGatewayStatus | null> => {
    try {
      const st = await fetchNestGatewayStatus(FEATURE_ID)
      setGateway(st)
      return st
    } catch {
      // 后端没连上时保持上一次的显示，不要把状态条闪没。
      return null
    }
  }, [])

  const refreshBridge = useCallback(async () => {
    try {
      const st = await fetchNestRunStatus(FEATURE_ID)
      setRunning(st.running)
    } catch {
      /* 后端暂时不可达，下一轮再试 */
    }
    try {
      setLog(await fetchNestRunLog(FEATURE_ID))
    } catch {
      /* 同上 */
    }
  }, [])

  useEffect(() => {
    void refreshGateway()
    void refreshBridge()
  }, [refreshGateway, refreshBridge])

  // 网关状态一直轻量轮询 —— 它可能被别人手动开了/关了，面板得跟上。
  useEffect(() => {
    const timer = window.setInterval(() => { void refreshGateway() }, GATEWAY_POLL_MS)
    return () => window.clearInterval(timer)
  }, [refreshGateway])

  // 桥在跑的时候才拉日志（没跑就不用一直刷）。
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => { void refreshBridge() }, RUN_POLL_MS)
    return () => window.clearInterval(timer)
  }, [running, refreshBridge])

  useEffect(() => {
    const box = logRef.current
    if (box) box.scrollTop = box.scrollHeight
  }, [log])

  const startBridge = useCallback(async (auto = false) => {
    if (bridgeBusy) return
    setBridgeBusy(true)
    try {
      const result = await runNestFeature(FEATURE_ID, { command: 'run' })
      setRunning(result.running)
      setLog(result.output || (await fetchNestRunLog(FEATURE_ID)))
      setNote(result.running
        ? `QQ 桥起来了（pid ${result.pid}）—— 去群里 @ 它试试。`
        : result.ok
          ? '桥跑完了（正常不会这样，它应该常驻接消息）—— 日志在下面。'
          : `桥没起来（退出码 ${result.exit_code}），日志在下面。`)
    } catch (e) {
      setNote(`${auto ? '网关开好了，但自动启动桥失败：' : '启动桥失败：'}${errText(e)}`)
    } finally {
      setBridgeBusy(false)
    }
  }, [bridgeBusy])

  const startGateway = useCallback(async () => {
    if (gatewayBusy) return
    setGatewayBusy(true)
    setNote('正在开 SnowLuma —— 它要注入到电脑上登录着的那个 QQ、再把 3001 端口开出来，最多等一分钟…')
    try {
      const st = await startNestGateway(FEATURE_ID)
      setGateway(st)
      // 后端开完会自动把端口换给机器人号（填了网关密码的话），换没换成功要看它说的。
      const uin = (st.uin || '').trim()
      const want = (st.expected_uin || '').trim()
      if (st.swap?.ok) {
        setNote(`网关开好了（${st.waited ?? '?'} 秒）：${st.swap.message}`
          + ' —— 接着把桥也起起来…')
      } else if (!uin) {
        setNote(`网关开了（${st.waited ?? '?'} 秒），但一个 QQ 号都没挂上 —— 先看一眼日志，确认没问题再手动点「启动 QQ 桥」。`)
      } else if (want && uin !== want) {
        // 挂到别的号上了：**不自动开桥** —— 那等于用错的号去群里说话。
        setNote(`⚠ 网关起来了，但它挂上的 QQ 是 ${uin}，不是机器人号 ${want}。${st.swap?.message || ''}`
          + (st.has_password ? ' 点下面「↻ 换给机器人号」再试一次。' : ' 去本面板下面的「⚙ QQ 桥的设置 → 接入方式 → 网关网页密码」把密码填上，就能自动换号。'))
      } else {
        setNote(`网关开好了（${st.waited ?? '?'} 秒，挂的号 ${uin}）—— 接着把桥也起起来…`)
      }
      // 只有号对得上（或号对不上时已经换过来了）才自动开桥。
      if (!uin || (want && uin !== want)) return
      // 桥可能本来就在跑（网关断了它只是一直重连）—— 那就别再起第二个，等它自己接上。
      const bridgeStatus = await fetchNestRunStatus(FEATURE_ID).catch(() => null)
      if (bridgeStatus?.running) {
        setRunning(true)
        setNote((n) => `${n}\n桥本来就在跑，它每 5 秒重连一次，马上就会接上。`)
      } else {
        await startBridge(true)
      }
    } catch (e) {
      setNote(`开网关失败：${errText(e)}`)
    } finally {
      setGatewayBusy(false)
      void refreshGateway()
    }
  }, [gatewayBusy, startBridge, refreshGateway])

  // 「换给机器人号」：开机自动换过一次还不对（比如机器人号是后来才登上的），点这个再来一次。
  const claimBot = useCallback(async () => {
    if (gatewayBusy) return
    setGatewayBusy(true)
    setNote('正在把网关的端口换给机器人号…（要把抢着的那个号摘下来再重新挂机器人号，几秒）')
    try {
      const st = await claimNestGateway(FEATURE_ID)
      setGateway(st)
      setNote(st.swap?.message || st.message)
      if (st.swap?.ok) {
        const bridgeStatus = await fetchNestRunStatus(FEATURE_ID).catch(() => null)
        if (bridgeStatus?.running) setRunning(true)
        else await startBridge(true)
      }
    } catch (e) {
      setNote(`换号失败：${errText(e)}`)
    } finally {
      setGatewayBusy(false)
      void refreshGateway()
    }
  }, [gatewayBusy, startBridge, refreshGateway])

  const stopBridge = useCallback(async () => {
    if (bridgeBusy) return
    setBridgeBusy(true)
    try {
      const r = await stopNestFeature(FEATURE_ID)
      setRunning(false)
      setNote(r.stopped ? '桥停了。' : '本来就没在跑。')
    } catch (e) {
      setNote(`停桥失败：${errText(e)}`)
    } finally {
      setBridgeBusy(false)
      void refreshBridge()
    }
  }, [bridgeBusy, refreshBridge])

  const online = !!gateway?.online
  const expectedUin = (gateway?.expected_uin || '').trim()
  const hasPassword = !!gateway?.has_password
  const mismatch = !!(gateway?.uin && expectedUin && gateway.uin !== expectedUin)

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
      {/* ---- 状态条 ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={`inline-block h-2.5 w-2.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-amber-500'}`} />
        <b className="text-[15px]">SnowLuma 网关</b>
        <span className="text-[12px] text-[var(--text-2)]">
          {gateway ? gateway.message : '查状态中…'}
        </span>
        {online && <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">端口 {gateway?.port}</span>}
        {gateway?.uin && (
          <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
            mismatch
              ? 'border-amber-400 text-amber-600'
              : 'border-[var(--border)] text-[var(--text-3)]'}`}>
            挂的 QQ {gateway.uin}{mismatch ? ' ≠ 机器人号' : ''}
          </span>
        )}
        <span className="text-[11px] text-[var(--text-3)]">桥：{running ? '在跑' : '没跑'}</span>
      </div>

      {/* ---- 挂错号的提醒（比任何按钮都重要）---- */}
      {mismatch && (
        <div className="mb-3 rounded-xl border border-amber-400 bg-amber-50 px-3 py-2 text-[12px] leading-relaxed text-amber-800">
          ⚠ 网关挂上的是 <b>{gateway?.uin}</b>，不是配置里的机器人 <b>{expectedUin}</b>。
          {hasPassword
            ? '点下面的「↻ 换给机器人号」，小窝会把占着端口的那个号摘下来、让机器人号顶上去。'
            : <>小窝能自动换号，但要先填网关网页密码 —— 去本面板下面的「⚙ QQ 桥的设置 → 接入方式 → 网关网页密码」把 SnowLuma 的登录密码填上。</>}
          现在开桥的话，说话的身份就是这个错的号。
        </div>
      )}

      {/* ---- 没填密码时的提醒（只在需要它的时候出现）---- */}
      {online && !hasPassword && !mismatch && (
        <p className="mb-3 text-[11px] text-[var(--text-3)]">
          想让网关在同时登两个 QQ 时自动挂到机器人号上，去
          本面板下面的「⚙ QQ 桥的设置 → 接入方式 → 网关网页密码」填上 SnowLuma 的网页密码即可。
        </p>
      )}

      {/* ---- 按钮 ---- */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!online ? (
          <button className="btn sm" disabled={gatewayBusy} onClick={() => void startGateway()}>
            {gatewayBusy ? '正在开…（最多等一分钟）' : '⚡ 开 QQ 网关'}
          </button>
        ) : (
          <>
            {!running && (
              <button className="btn sm" disabled={bridgeBusy || gatewayBusy} onClick={() => void startBridge()}>
                {bridgeBusy ? '正在起…' : '▶ 启动 QQ 桥'}
              </button>
            )}
            {running && (
              <button className="btn ghost sm" disabled={bridgeBusy} onClick={() => void stopBridge()}>
                ⏹ 停掉 QQ 桥
              </button>
            )}
            {hasPassword && (
              <button className="btn ghost sm" disabled={gatewayBusy}
                title="把占着 3001 端口的别的号摘下来，让配置里的机器人号顶上去"
                onClick={() => void claimBot()}>
                {gatewayBusy ? '换号中…' : '↻ 换给机器人号'}
              </button>
            )}
            {gateway?.started_by_nest && (
              <button className="btn ghost sm" disabled={gatewayBusy} title="关掉从小窝起的 SnowLuma"
                onClick={() => {
                  // 重开 = 停桥 → 关网关 → 再开（换过 QQ 号之后用）。
                  void (async () => {
                    if (running) await stopNestFeature(FEATURE_ID).catch(() => {})
                    setRunning(false)
                    setNote('正在关网关…')
                    try {
                      await stopNestGateway(FEATURE_ID)
                      setNote('网关关掉了，重新开…')
                      await startGateway()
                    } catch (e) {
                      setNote(`重开失败：${errText(e)}`)
                    }
                  })()
                }}>
                ↻ 重开网关
              </button>
            )}
          </>
        )}
        <button className="btn ghost sm" disabled={gatewayBusy || bridgeBusy}
          onClick={() => { void refreshGateway(); void refreshBridge() }}>
          刷新
        </button>
      </div>

      {!online && (
        <p className="mb-3 text-[11px] text-[var(--text-3)]">
          网关就是 QQ 的 OneBot 服务（SnowLuma）。它没开的时候桥连 3001 必然被拒绝 ——
          先点上面那个按钮，起来之后桥会自动接上。网关目录在本面板下面的「⚙ QQ 桥的设置 → 接入方式」里能改。
        </p>
      )}

      {note && (
        <div className="mb-3 rounded-xl border border-[color-mix(in_srgb,var(--pink)_30%,var(--border))] bg-[var(--pink-soft)] px-3 py-2 text-[12px] leading-relaxed text-[var(--pink-deep)]">
          {note}
        </div>
      )}

      {/* ---- 桥的日志 ---- */}
      <div className="mb-1 flex items-center justify-between">
        <span className="eyebrow">桥的日志</span>
        <button className="btn ghost sm" onClick={() => void refreshBridge()}>刷新</button>
      </div>
      <pre ref={logRef}
        className="h-56 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-[12px] leading-relaxed text-[var(--text-2)]">
        {log || '（还没有输出 —— 先把网关开起来，再启动 QQ 桥）'}
      </pre>

      {/* ---- 自己的设置（Block 二 ②）----
          以前这些开关和别的功能一起挤在「🛠 设置与工具 → ⚙ 功能开关」里，
          找起来要在功能清单里翻；现在跟着 QQ 桥待在同一个面板，改完立刻生效、不用重启。 */}
      <div className="mt-4 border-t border-[var(--border)] pt-3">
        <div className="mb-2 flex flex-wrap items-baseline gap-2">
          <span className="text-[14px] font-bold text-[var(--text)]">⚙ QQ 桥的设置</span>
          <span className="text-[11px] text-[var(--text-3)]">
            白名单 / 演谁 / 音色 / 表情包 / 接入方式 —— 改完下一轮就用上，不用重启
          </span>
        </div>
        <NestSettingsPanel onlyId={FEATURE_ID} bare />
      </div>
    </section>
  )
}
