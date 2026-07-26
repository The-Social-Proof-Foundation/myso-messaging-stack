import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

type Visibility = DocumentVisibilityState;

function installBrowserMocks(initial: {
  visibilityState: Visibility;
  hasFocus: boolean;
}) {
  let visibilityState = initial.visibilityState;
  let focused = initial.hasFocus;
  const docListeners = new Map<string, Set<EventListener>>();
  const winListeners = new Map<string, Set<EventListener>>();

  const add = (
    map: Map<string, Set<EventListener>>,
    type: string,
    fn: EventListener,
  ) => {
    let set = map.get(type);
    if (!set) {
      set = new Set();
      map.set(type, set);
    }
    set.add(fn);
  };
  const remove = (
    map: Map<string, Set<EventListener>>,
    type: string,
    fn: EventListener,
  ) => {
    map.get(type)?.delete(fn);
  };
  const dispatch = (map: Map<string, Set<EventListener>>, type: string) => {
    for (const fn of map.get(type) ?? []) {
      fn(new Event(type));
    }
  };

  const documentMock = {
    get visibilityState() {
      return visibilityState;
    },
    hasFocus: () => focused,
    addEventListener: (type: string, fn: EventListener) =>
      add(docListeners, type, fn),
    removeEventListener: (type: string, fn: EventListener) =>
      remove(docListeners, type, fn),
    dispatchEvent: (event: Event) => {
      dispatch(docListeners, event.type);
      return true;
    },
  };

  const windowMock = {
    addEventListener: (type: string, fn: EventListener) =>
      add(winListeners, type, fn),
    removeEventListener: (type: string, fn: EventListener) =>
      remove(winListeners, type, fn),
    dispatchEvent: (event: Event) => {
      dispatch(winListeners, event.type);
      return true;
    },
  };

  vi.stubGlobal('document', documentMock);
  vi.stubGlobal('window', windowMock);

  return {
    setVisibility(state: Visibility) {
      visibilityState = state;
    },
    setFocused(value: boolean) {
      focused = value;
    },
    dispatchDocument(type: string) {
      documentMock.dispatchEvent(new Event(type));
    },
    dispatchWindow(type: string) {
      windowMock.dispatchEvent(new Event(type));
    },
  };
}

describe('page-engagement', () => {
  let mocks: ReturnType<typeof installBrowserMocks>;

  beforeEach(() => {
    mocks = installBrowserMocks({visibilityState: 'visible', hasFocus: true});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function load() {
    return import('./page-engagement');
  }

  it('is engaged when visible and focused', async () => {
    const {isPageEngaged} = await load();
    expect(isPageEngaged()).toBe(true);
  });

  it('is not engaged when the document is hidden', async () => {
    const {isPageEngaged} = await load();
    mocks.setVisibility('hidden');
    expect(isPageEngaged()).toBe(false);
  });

  it('is not engaged when the window is unfocused', async () => {
    const {isPageEngaged} = await load();
    mocks.setFocused(false);
    expect(isPageEngaged()).toBe(false);
  });

  it('notifies subscribers on visibility and focus changes', async () => {
    const {subscribePageEngagement, __resetPageEngagementForTests} =
      await load();
    const seen: boolean[] = [];
    const unsub = subscribePageEngagement((engaged) => {
      seen.push(engaged);
    });
    expect(seen).toEqual([true]);

    mocks.setVisibility('hidden');
    mocks.dispatchDocument('visibilitychange');
    expect(seen.at(-1)).toBe(false);

    mocks.setVisibility('visible');
    mocks.dispatchDocument('visibilitychange');
    expect(seen.at(-1)).toBe(true);

    mocks.setFocused(false);
    mocks.dispatchWindow('blur');
    expect(seen.at(-1)).toBe(false);

    unsub();
    __resetPageEngagementForTests();
  });

  it('treats pagehide as not engaged until pageshow', async () => {
    const {
      isPageEngaged,
      subscribePageEngagement,
      __resetPageEngagementForTests,
    } = await load();
    const seen: boolean[] = [];
    const unsub = subscribePageEngagement((engaged) => {
      seen.push(engaged);
    });
    expect(seen).toEqual([true]);

    mocks.dispatchWindow('pagehide');
    expect(isPageEngaged()).toBe(false);
    expect(seen.at(-1)).toBe(false);

    mocks.setVisibility('visible');
    mocks.setFocused(true);
    expect(isPageEngaged()).toBe(false);

    mocks.dispatchWindow('pageshow');
    expect(isPageEngaged()).toBe(true);
    expect(seen.at(-1)).toBe(true);

    unsub();
    __resetPageEngagementForTests();
  });

  it('dedupes identical engagement values', async () => {
    const {subscribePageEngagement, __resetPageEngagementForTests} =
      await load();
    const seen: boolean[] = [];
    const unsub = subscribePageEngagement((engaged) => {
      seen.push(engaged);
    });
    mocks.dispatchWindow('focus');
    mocks.dispatchWindow('focus');
    expect(seen).toEqual([true]);
    unsub();
    __resetPageEngagementForTests();
  });
});
