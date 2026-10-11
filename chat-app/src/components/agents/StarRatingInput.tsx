import {Star} from 'lucide-react';
import {useId, useState} from 'react';

interface StarRatingInputProps {
  value: number;
  onChange: (stars: number) => void;
  disabled?: boolean;
  label?: string;
}

const LABELS = ['Poor', 'Fair', 'Good', 'Very good', 'Excellent'] as const;

/**
 * 1-5 star picker as a radio group, so it works with the keyboard (arrow keys move the
 * selection) and reads correctly to a screen reader. `0` means nothing chosen yet.
 */
export function StarRatingInput({
  value,
  onChange,
  disabled = false,
  label = 'Rating',
}: Readonly<StarRatingInputProps>) {
  const name = useId();
  const [hover, setHover] = useState(0);
  const shown = hover || value;

  return (
    <div>
      <div
        role="radiogroup"
        aria-label={label}
        className="inline-flex items-center gap-0.5"
        onMouseLeave={() => setHover(0)}
      >
        {[1, 2, 3, 4, 5].map((n) => (
          <label
            key={n}
            className={`cursor-pointer rounded p-0.5 focus-within:ring-2 focus-within:ring-primary-500 ${
              disabled ? 'cursor-not-allowed opacity-50' : ''
            }`}
            onMouseEnter={() => !disabled && setHover(n)}
          >
            <input
              type="radio"
              name={name}
              value={n}
              checked={value === n}
              disabled={disabled}
              onChange={() => onChange(n)}
              className="sr-only"
              aria-label={`${n} ${n === 1 ? 'star' : 'stars'}: ${LABELS[n - 1]}`}
            />
            <Star
              className={`h-7 w-7 ${
                n <= shown
                  ? 'fill-amber-400 text-amber-400'
                  : 'text-secondary-300 dark:text-secondary-600'
              }`}
              strokeWidth={1.5}
              aria-hidden
            />
          </label>
        ))}
      </div>
      <p className="mt-1 h-4 text-xs text-secondary-500 dark:text-secondary-400" aria-live="polite">
        {shown > 0 ? LABELS[shown - 1] : 'Choose 1 to 5 stars'}
      </p>
    </div>
  );
}
