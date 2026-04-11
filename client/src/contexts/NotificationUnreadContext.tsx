import { type SetStateAction, useCallback, useEffect, useState } from 'react';
import { fetchNotificationsPaginated } from '../lib/api';
import type { NotificationUnreadContextValue, WithChildren } from '../types';
import { NotificationUnreadContext } from './notification-unread-context';
import { useRefresh } from './useRefresh';

function sanitizeUnreadCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

async function loadUnreadCount(): Promise<number> {
  const notificationList = await fetchNotificationsPaginated(1, 1);
  return sanitizeUnreadCount(notificationList.unread_count);
}

export function NotificationUnreadProvider({ children }: WithChildren) {
  const { refreshSignal = 0 } = useRefresh();
  const [unreadCount, setUnreadCountState] = useState(0);

  const setUnreadCount = useCallback<NotificationUnreadContextValue['setUnreadCount']>((value: SetStateAction<number>) => {
    setUnreadCountState((previousValue) => {
      const nextValue = typeof value === 'function' ? value(previousValue) : value;
      return sanitizeUnreadCount(nextValue);
    });
  }, []);

  const refreshUnreadCount = useCallback(async () => {
    try {
      setUnreadCountState(await loadUnreadCount());
    } catch (error) {
      console.error('Failed to load unread notification count', error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    void loadUnreadCount()
      .then((nextUnreadCount) => {
        if (!cancelled) {
          setUnreadCountState(nextUnreadCount);
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load unread notification count', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (refreshSignal <= 0) {
      return undefined;
    }

    let cancelled = false;

    void loadUnreadCount()
      .then((nextUnreadCount) => {
        if (!cancelled) {
          setUnreadCountState(nextUnreadCount);
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load unread notification count', error);
      });

    return () => {
      cancelled = true;
    };
  }, [refreshSignal]);

  return (
    <NotificationUnreadContext.Provider value={{ unreadCount, setUnreadCount, refreshUnreadCount }}>
      {children}
    </NotificationUnreadContext.Provider>
  );
}
