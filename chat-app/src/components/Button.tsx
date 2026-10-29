import type {ButtonHTMLAttributes, ReactNode} from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const press = 'active:scale-[0.98] active:duration-100'

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: `bg-primary-600 text-white hover:bg-primary-500 active:bg-primary-800 dark:bg-primary-600 dark:hover:bg-primary-400 dark:active:bg-primary-800 ${press}`,
  secondary: `border border-secondary-300 bg-white text-secondary-700 hover:bg-secondary-100 active:bg-secondary-200 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-200 dark:hover:bg-secondary-700 dark:active:bg-secondary-900 ${press}`,
  ghost: `text-secondary-600 hover:bg-secondary-100 active:bg-secondary-200 dark:text-secondary-300 dark:hover:bg-secondary-700 dark:active:bg-secondary-900 ${press}`,
  danger: `border border-danger-300 text-danger-600 hover:bg-danger-50 active:bg-danger-100 dark:border-danger-700 dark:text-danger-400 dark:hover:bg-danger-950/40 dark:active:bg-danger-950 ${press}`,
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-4 py-2 text-sm',
};

/** Shared button so dialogs and panels stop hand-rolling button classes. */
export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...rest
}: Readonly<ButtonProps>) {
  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center rounded-lg font-medium transition-[color,background-color,transform] duration-200 ease-out disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT_CLASS[variant]} ${SIZE_CLASS[size]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
