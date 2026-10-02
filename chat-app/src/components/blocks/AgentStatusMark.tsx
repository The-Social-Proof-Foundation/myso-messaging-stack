import type {AgentChartStatus} from '@/lib/agents/agent-chart';
import {cn} from '@/lib/utils';

/** Green when the agent is active, red when it is inactive or revoked. Place inside a relative avatar. */
export function AgentStatusDot({
  status,
  className,
}: Readonly<{status: AgentChartStatus; className?: string}>) {
  const active = status === 'active';
  return (
    <span
      role="img"
      aria-label={active ? 'Active' : 'Deactivated'}
      className={cn(
        'absolute top-[85.35%] left-[14.65%] size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card',
        active ? 'bg-emerald-500' : 'bg-red-500',
        className,
      )}
    />
  );
}
