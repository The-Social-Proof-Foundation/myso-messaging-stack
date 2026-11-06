import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  clearSealedPreviews,
  createMemorySealedPreviewBackend,
  loadSealedPreviews,
  saveSealedPreviews,
  setSealedPreviewBackendForTests,
} from './sealed-preview-store';
import type { StoredSidebarPreview } from './sidebar-chrome-store';

const WALLET = '0x' + 'ab'.repeat(32);
const OTHER = '0x' + 'cd'.repeat(32);

function previews(text: string, order = 3): Map<string, StoredSidebarPreview> {
  return new Map([['0xgroup', { text, order, verified: true, at: 1000 }]]);
}

describe('sealed-preview-store', () => {
  let backend: ReturnType<typeof createMemorySealedPreviewBackend>;

  beforeEach(() => {
    backend = createMemorySealedPreviewBackend();
    setSealedPreviewBackendForTests(backend);
  });

  afterEach(() => {
    setSealedPreviewBackendForTests(null);
  });

  it('round-trips previews', async () => {
    await saveSealedPreviews(WALLET, previews('see you at 8'));
    const loaded = await loadSealedPreviews(WALLET);
    expect(loaded.get('0xgroup')?.text).toBe('see you at 8');
  });

  it('never stores preview text in cleartext', async () => {
    await saveSealedPreviews(WALLET, previews('secret plans'));
    const stored = backend.snapshot().get(`previews:${WALLET}`) as { ct: ArrayBuffer };
    const bytes = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(stored.ct));
    expect(bytes).not.toContain('secret plans');
  });

  it("does not open another wallet's blob", async () => {
    await saveSealedPreviews(WALLET, previews('mine'));
    // Move WALLET's sealed blob under OTHER's key: the wallet-bound AAD must reject it.
    backend.snapshot().set(`previews:${OTHER}`, backend.snapshot().get(`previews:${WALLET}`));
    expect((await loadSealedPreviews(OTHER)).size).toBe(0);
  });

  it('logout clear makes previews unreadable', async () => {
    await saveSealedPreviews(WALLET, previews('gone'));
    await clearSealedPreviews();
    expect((await loadSealedPreviews(WALLET)).size).toBe(0);
  });
});
