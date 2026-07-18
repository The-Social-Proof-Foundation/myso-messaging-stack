import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

interface MobileChatNavContextValue {
  /** Hide AppHeader when mobile chat thread is open. */
  hideAppHeader: boolean;
  setHideAppHeader: (hide: boolean) => void;
}

const MobileChatNavContext = createContext<MobileChatNavContextValue | null>(
  null,
);

export function MobileChatNavProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const [hideAppHeader, setHideAppHeaderState] = useState(false);

  const setHideAppHeader = useCallback((hide: boolean) => {
    setHideAppHeaderState(hide);
  }, []);

  const value = useMemo(
    () => ({ hideAppHeader, setHideAppHeader }),
    [hideAppHeader, setHideAppHeader],
  );

  return (
    <MobileChatNavContext.Provider value={value}>
      {children}
    </MobileChatNavContext.Provider>
  );
}

export function useMobileChatNav(): MobileChatNavContextValue {
  const ctx = useContext(MobileChatNavContext);
  if (!ctx) {
    throw new Error(
      'useMobileChatNav must be used within MobileChatNavProvider',
    );
  }
  return ctx;
}
