export interface ModelVendor {
  name: string;
  /** Brand color, tuned to read on both the dark and light card backgrounds. */
  color: string;
}

const VENDORS: ReadonlyArray<{match: RegExp; vendor: ModelVendor}> = [
  {match: /claude|anthropic|haiku|sonnet|opus/i, vendor: {name: 'Anthropic', color: '#D97757'}},
  {match: /gpt|openai|\bo[134](-|\b)|chatgpt/i, vendor: {name: 'OpenAI', color: '#10A37F'}},
  {match: /gemini|gemma|google/i, vendor: {name: 'Google', color: '#4285F4'}},
  {match: /llama|meta/i, vendor: {name: 'Meta', color: '#0A7CFF'}},
  {match: /mistral|mixtral|codestral/i, vendor: {name: 'Mistral', color: '#FA520F'}},
  {match: /deepseek/i, vendor: {name: 'DeepSeek', color: '#4D6BFE'}},
  {match: /grok|xai/i, vendor: {name: 'xAI', color: '#8B8B93'}},
  {match: /qwen|alibaba/i, vendor: {name: 'Alibaba', color: '#7C6CF2'}},
  {match: /kimi|moonshot/i, vendor: {name: 'Moonshot', color: '#2DA7E0'}},
  {match: /command|cohere/i, vendor: {name: 'Cohere', color: '#39B79A'}},
  {match: /nova|amazon|titan/i, vendor: {name: 'Amazon', color: '#FF9900'}},
];

/** The company behind a model, from its id and display name; `null` when unrecognized. */
export function modelVendor(modelId: string, displayName?: string | null): ModelVendor | null {
  const haystack = `${modelId} ${displayName ?? ''}`;
  return VENDORS.find((entry) => entry.match.test(haystack))?.vendor ?? null;
}
