import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface CreateMessageContextValue {
  /** True when AuthenticatedApp has registered an open handler. */
  canCreateMessage: boolean;
  /** Opens the new-message dialog when a handler is registered (authenticated shell). */
  openCreateMessage: () => void;
  /** AuthenticatedApp registers its modal opener here. */
  registerOpenHandler: (handler: (() => void) | null) => void;
}

const CreateMessageContext = createContext<CreateMessageContextValue | null>(
  null,
);

export function CreateMessageProvider({
  children,
}: Readonly<{ children: ReactNode }>) {
  const handlerRef = useRef<(() => void) | null>(null);
  const [canCreateMessage, setCanCreateMessage] = useState(false);

  const registerOpenHandler = useCallback((handler: (() => void) | null) => {
    handlerRef.current = handler;
    setCanCreateMessage(handler != null);
  }, []);

  const openCreateMessage = useCallback(() => {
    handlerRef.current?.();
  }, []);

  const value = useMemo(
    () => ({ canCreateMessage, openCreateMessage, registerOpenHandler }),
    [canCreateMessage, openCreateMessage, registerOpenHandler],
  );

  return (
    <CreateMessageContext.Provider value={value}>
      {children}
    </CreateMessageContext.Provider>
  );
}

export function useCreateMessage(): CreateMessageContextValue {
  const ctx = useContext(CreateMessageContext);
  if (!ctx) {
    throw new Error('useCreateMessage must be used within CreateMessageProvider');
  }
  return ctx;
}

/** Registers the authenticated shell's open handler for the header "+ New" button. */
export function useRegisterCreateMessageHandler(handler: () => void): void {
  const { registerOpenHandler } = useCreateMessage();

  useEffect(() => {
    registerOpenHandler(handler);
    return () => registerOpenHandler(null);
  }, [handler, registerOpenHandler]);
}
