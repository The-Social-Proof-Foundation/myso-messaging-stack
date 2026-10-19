import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatSettingsSection } from '../components/admin/ChatSettingsSection';
import { chatHasAnotherHuman } from './chat-has-another-human';

const ME = '0x1111';
const HUMAN = '0x2222';
const AGENT = '0x3333';

describe('chatHasAnotherHuman', () => {
  const isAgent = (address: string) => address.toLowerCase() === AGENT;

  it('is true only when some other member is not an agent', () => {
    expect(
      chatHasAnotherHuman({
        memberAddresses: [ME, HUMAN],
        selfAddresses: [ME],
        isAgent,
      }),
    ).toBe(true);
    expect(
      chatHasAnotherHuman({
        memberAddresses: [ME, AGENT],
        selfAddresses: [ME],
        isAgent,
      }),
    ).toBe(false);
    expect(
      chatHasAnotherHuman({
        memberAddresses: [ME, AGENT, HUMAN],
        selfAddresses: [ME],
        isAgent,
      }),
    ).toBe(true);
  });
});

describe('ChatSettingsSection', () => {
  const props = {
    notificationsEnabled: true,
    readReceiptsEnabled: true,
    onlinePresenceEnabled: true,
    loading: false,
    savingKey: null,
    error: null,
    onToggleNotifications: () => {},
    onToggleReadReceipts: () => {},
    onToggleOnlinePresence: () => {},
  };

  it('hides read receipts and online status when no other human is present', () => {
    const html = renderToStaticMarkup(createElement(ChatSettingsSection, { ...props, showPresenceSettings: false }));
    expect(html).toContain('Notifications');
    expect(html).not.toContain('Read receipts');
    expect(html).not.toContain('Show online status');
  });

  it('shows read receipts and online status for a human conversation', () => {
    const html = renderToStaticMarkup(createElement(ChatSettingsSection, { ...props, showPresenceSettings: true }));
    expect(html).toContain('Notifications');
    expect(html).toContain('Read receipts');
    expect(html).toContain('Show online status');
  });
});
