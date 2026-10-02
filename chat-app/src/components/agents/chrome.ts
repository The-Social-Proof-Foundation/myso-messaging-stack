/** Matches Settings cards and the header "New" button. */
export const cardClass =
  'overflow-hidden rounded-xl border border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-900';

export const sectionTitleClass =
  'font-chakra text-sm font-medium tracking-wide text-secondary-800 dark:text-secondary-200';

export const pageTitleClass =
  'text-2xl font-semibold text-primary-900 dark:text-primary-50';

export const fieldClass =
  'rounded-md border border-secondary-300 bg-white px-2 py-1.5 text-sm text-secondary-800 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-100';

export const buttonClass =
  'inline-flex items-center justify-center rounded-md border border-secondary-300 bg-white px-3 py-1.5 text-xs font-medium text-secondary-700 hover:bg-secondary-100 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-200 dark:hover:bg-secondary-700';

export const chipClass = (selected: boolean) =>
  `rounded-md border px-3 py-1.5 text-sm ${
    selected
      ? 'border-secondary-300 bg-secondary-100 text-secondary-900 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-50'
      : 'border-transparent bg-transparent text-secondary-600 hover:bg-secondary-100 dark:text-secondary-300 dark:hover:bg-secondary-800'
  }`;
