import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

export interface CalloutButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** true = 100% corner opacity, false = 50%. Default: true */
  borderOpacity?: boolean;
  children?: ReactNode;
}

/**
 * Lean port of mysocial-frontend CalloutButton — square frame + corner accents.
 * Uses chat-app zinc tokens instead of CSS vars / cva / Slot.
 */
export const CalloutButton = forwardRef<HTMLButtonElement, CalloutButtonProps>(
  ({ className = '', borderOpacity = true, children, ...props }, ref) => {
    const cornerBorder = borderOpacity
      ? 'border-primary-900 dark:border-primary-50'
      : 'border-primary-900/50 dark:border-primary-50/50';

    return (
      <button
        ref={ref}
        type="button"
        className={[
          'relative inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-none',
          'border border-secondary-700 bg-white text-sm font-medium text-primary-900',
          'hover:bg-secondary-50 hover:text-primary-900',
          'dark:bg-secondary-900 dark:text-primary-50 dark:hover:bg-secondary-800 dark:hover:text-primary-50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-900 focus-visible:ring-offset-2',
          'disabled:pointer-events-none disabled:opacity-50',
          '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
          'hover:[&_.corner-accent]:!border-primary-900 dark:hover:[&_.corner-accent]:!border-primary-50',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        {...props}
      >
        <span
          className={`corner-accent absolute top-0 left-0 z-20 h-2 w-2 border-t-2 border-l-2 transition-colors duration-75 ${cornerBorder}`}
        />
        <span
          className={`corner-accent absolute top-0 right-0 z-20 h-2 w-2 border-t-2 border-r-2 transition-colors duration-75 ${cornerBorder}`}
        />
        <span
          className={`corner-accent absolute bottom-0 left-0 z-20 h-2 w-2 border-b-2 border-l-2 transition-colors duration-75 ${cornerBorder}`}
        />
        <span
          className={`corner-accent absolute right-0 bottom-0 z-20 h-2 w-2 border-r-2 border-b-2 transition-colors duration-75 ${cornerBorder}`}
        />
        <span className="relative z-10">{children}</span>
      </button>
    );
  },
);
CalloutButton.displayName = 'CalloutButton';
