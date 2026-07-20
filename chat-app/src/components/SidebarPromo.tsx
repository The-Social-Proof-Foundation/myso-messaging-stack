import { useEffect, useState, type MouseEvent } from 'react';
import { X } from 'lucide-react';

const DISMISS_KEY = 'chat-app-promo-sub-agentic-conversations-v1';
const DISMISS_TTL_MS = 60 * 60 * 1000; // 1 hour
const DOCS_URL = 'https://docs.mysocial.network/mysocial/mydata/ai-agents';

function isDismissed(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY);
    if (!raw) return false;
    const until = Number(raw);
    if (!Number.isFinite(until)) return false;
    return Date.now() < until;
  } catch {
    return false;
  }
}

/**
 * Compact bottom-of-sidebar teaser card (dismissible for 1 hour).
 * Card opens AI Agents docs; close dismisses without navigating.
 */
export function SidebarPromo() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setVisible(!isDismissed());
  }, []);

  if (!visible) return null;

  function dismiss(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now() + DISMISS_TTL_MS));
    } catch {
      // ignore
    }
    setVisible(false);
  }

  return (
    <div className="shrink-0 overflow-visible p-3">
      <a
        href={DOCS_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="block origin-center overflow-hidden rounded-2xl border border-secondary-200 bg-secondary-100 shadow-sm transition-transform duration-200 ease-out hover:scale-102 active:scale-100 dark:border-secondary-600 dark:bg-secondary-700"
      >
        <div className="relative">
          <img
            src="/sub-agentic-convos-banner.webp"
            alt=""
            className="h-28 w-full object-cover"
            draggable={false}
          />
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss announcement"
            className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-colors hover:bg-black/75"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2.5} />
          </button>
        </div>
        <div className="space-y-1.5 px-3.5 py-3">
          <p className="font-chakra text-[15px] font-semibold tracking-tight text-secondary-900 dark:text-white">
            Sub-Agentic Conversations
          </p>
          <p className="text-xs leading-relaxed text-secondary-600 dark:text-secondary-300">
            Organization workspaces, permissioned multi-agent workflows, and
            shared inboxes that run alongside human chats.{' '}
            <b className="font-chakra font-semibold">Coming soon.</b>
          </p>
        </div>
      </a>
    </div>
  );
}
