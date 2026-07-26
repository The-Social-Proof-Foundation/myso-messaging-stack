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

  it('is engaged and visible when visible and focused', async () => {
    const {isPageEngaged, isPageVisible} = await load();
    expect(isPageEngaged()).toBe(true);
    expect(isPageVisible()).toBe(true);
  });

  it('is neither engaged nor visible when the document is hidden', async () => {
    const {isPageEngaged, isPageVisible} = await load();
    mocks.setVisibility('hidden');
    expect(isPageEngaged()).toBe(false);
    expect(isPageVisible()).toBe(false);
  });

  it('stays visible but not engaged when the window is unfocused', async () => {
    const {isPageEngaged, isPageVisible} = await load();
    mocks.setFocused(false);
    expect(isPageVisible()).toBe(true);
    expect(isPageEngaged()).toBe(false);
  });

  it('notifies engagement and visibility subscribers independently', async () => {
    const {
      subscribePageEngagement,
      subscribePageVisibility,
      __resetPageEngagementForTests,
    } = await load();
    const engagedSeen: boolean[] = [];
    const visibleSeen: boolean[] = [];
    const unsubE = subscribePageEngagement((v) => {
      engagedSeen.push(v);
    });
    const unsubV = subscribePageVisibility((v) => {
      visibleSeen.push(v);
    });
    expect(engagedSeen).toEqual([true]);
    expect(visibleSeen).toEqual([true]);

    mocks.setFocused(false);
    mocks.dispatchWindow('blur');
    expect(engagedSeen.at(-1)).toBe(false);
    // Visibility unchanged — other OS app with tab still open.
    expect(visibleSeen).toEqual([true]);

    mocks.setVisibility('hidden');
    mocks.dispatchDocument('visibilitychange');
    expect(engagedSeen.at(-1)).toBe(false);
    expect(visibleSeen.at(-1)).toBe(false);

    mocks.setVisibility('visible');
    mocks.setFocused(true);
    mocks.dispatchDocument('visibilitychange');
    expect(visibleSeen.at(-1)).toBe(true);
    expect(engagedSeen.at(-1)).toBe(true);

    unsubE();
    unsubV();
    __resetPageEngagementForTests();
  });

  it('treats pagehide as not visible/engaged until pageshow', async () => {
    const {
      isPageEngaged,
      isPageVisible,
      subscribePageEngagement,
      subscribePageVisibility,
      __resetPageEngagementForTests,
    } = await load();
    const engagedSeen: boolean[] = [];
    const visibleSeen: boolean[] = [];
    const unsubE = subscribePageEngagement((v) => {
      engagedSeen.push(v);
    });
    const unsubV = subscribePageVisibility((v) => {
      visibleSeen.push(v);
    });

    mocks.dispatchWindow('pagehide');
    expect(isPageEngaged()).toBe(false);
    expect(isPageVisible()).toBe(false);
    expect(engagedSeen.at(-1)).toBe(false);
    expect(visibleSeen.at(-1)).toBe(false);

    mocks.setVisibility('visible');
    mocks.setFocused(true);
    expect(isPageEngaged()).toBe(false);
    expect(isPageVisible()).toBe(false);

    mocks.dispatchWindow('pageshow');
    expect(isPageEngaged()).toBe(true);
    expect(isPageVisible()).toBe(true);
    expect(engagedSeen.at(-1)).toBe(true);
    expect(visibleSeen.at(-1)).toBe(true);

    unsubE();
    unsubV();
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
