import {cn} from '@/lib/utils';

interface MysoAmountProps {
  /** Numeric amount, or an em dash when the value is missing. */
  amount: string;
  className?: string;
  unitClassName?: string;
}

/** Amount with the MySo unit in muted type, so the number stays the emphasis. */
export function MysoAmount({amount, className, unitClassName}: Readonly<MysoAmountProps>) {
  if (amount === '—' || amount === '') {
    return <span className={className}>—</span>;
  }
  return (
    <span className={cn('inline-flex items-baseline gap-1', className)}>
      <span>{amount}</span>
      <span className={cn('font-normal text-secondary-400 dark:text-secondary-500', unitClassName)}>
        MySo
      </span>
    </span>
  );
}
