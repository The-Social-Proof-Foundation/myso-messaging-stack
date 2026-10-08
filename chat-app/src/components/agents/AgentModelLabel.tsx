import {useAgentModel} from '@/hooks/agents/useAgentModel';
import {modelVendor} from '@/lib/agents/model-vendor';

/**
 * The agent's model name in its company's color. Falls back to `fallback` (the role label) while the
 * model is unknown, for example before agent keys are unlocked.
 */
export function AgentModelLabel({
  agentId,
  fallback,
  className,
}: Readonly<{agentId: string; fallback: string; className?: string}>) {
  const model = useAgentModel(agentId);
  if (!model) return <span className={className}>{fallback}</span>;
  const vendor = modelVendor(model.modelId, model.label);
  const title = [
    vendor ? `${model.label} · ${vendor.name}` : model.label,
    model.source === 'default' ? 'server default (no model picked for this agent)' : null,
  ]
    .filter(Boolean)
    .join(' — ');
  return (
    <span
      className={className}
      style={vendor ? {color: vendor.color} : undefined}
      title={title}
    >
      {model.label}
    </span>
  );
}
