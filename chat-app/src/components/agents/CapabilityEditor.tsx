import {chipClass} from './chrome';
import {
  CAPABILITY_LABELS,
  CAPABILITY_NAMES,
  CAPABILITY_PRESETS,
  hasCapability,
  presetForMask,
  toggleCapability,
  type CapabilityPresetId,
} from '../../lib/agents/capabilities';

interface CapabilityEditorProps {
  mask: number;
  onChange: (mask: number) => void;
}

export function CapabilityEditor({mask, onChange}: Readonly<CapabilityEditorProps>) {
  const preset = presetForMask(mask);

  function applyPreset(id: CapabilityPresetId) {
    if (id === 'custom') return;
    const found = CAPABILITY_PRESETS.find((p) => p.id === id);
    if (found) onChange(found.mask);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {CAPABILITY_PRESETS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => applyPreset(item.id)}
            className={`${chipClass(preset === item.id)} text-xs`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-secondary-500 dark:text-secondary-400">
        {preset === 'custom'
          ? 'Custom capability mix'
          : CAPABILITY_PRESETS.find((p) => p.id === preset)?.description}
      </p>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {CAPABILITY_NAMES.map((name) => (
          <label
            key={name}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-secondary-700 hover:bg-secondary-50 dark:text-secondary-200 dark:hover:bg-secondary-800"
          >
            <input
              type="checkbox"
              checked={hasCapability(mask, name)}
              onChange={() => onChange(toggleCapability(mask, name))}
            />
            {CAPABILITY_LABELS[name]}
          </label>
        ))}
      </div>
    </div>
  );
}
