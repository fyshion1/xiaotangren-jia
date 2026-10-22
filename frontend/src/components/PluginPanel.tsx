export default function PluginPanel({ featureId, title }: { featureId: string; title: string }) {
  return <iframe title={title} src={`/api/plugins/${encodeURIComponent(featureId)}/ui/`}
    className="w-full min-h-[80dvh] rounded-xl border-0" />
}
