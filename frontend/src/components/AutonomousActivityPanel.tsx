import NestSettingsPanel from './NestSettingsPanel'
import QqExploration from './QqExploration'
import AutonomyControl from './AutonomyControl'

export default function AutonomousActivityPanel() {
  return <>
    <div className="nest-room-heading"><div>
      <h2>自主活动与沙盒</h2>
      <p>看看她们在探索什么，管理活动节奏、预算、项目审批和独立工作区。</p>
    </div></div>
    <AutonomyControl />
    <QqExploration />
    <details className="mt-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <summary className="cursor-pointer font-semibold">QQ 娱乐互动与通知设置</summary>
      <p className="my-2 text-xs text-[var(--text-3)]">这些频率只管 QQ 娱乐互动，不限制独立探索或沙盒消息。沙盒消息全天可主动找你，不要求先回复。她可以先通过 QQ 提预算愿望，再由你到前端批准资源。</p>
      <NestSettingsPanel onlyId="qq_bridge" scope="autonomy" bare />
    </details>
  </>
}
