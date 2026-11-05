'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type ApiNotification } from '@/lib/api';
import { useImportProgress } from '@/lib/import-progress-context';
import { getAccessToken } from '@/lib/auth';
import { subscribebasefyioRealtime } from '@/lib/basefyio-realtime';

export const BASEFYIO_NOTIFY_EVENT = 'basefyio-notify-event';

type AppNotificationType = 'ai' | 'import' | 'feedback';

export type AppNotification = {
  id: string;
  type: AppNotificationType;
  title: string;
  message: string;
  createdAt: number;
  href?: string;
  read: boolean;
};

type NotifyPayload = {
  type: AppNotificationType;
  title: string;
  message: string;
  href?: string;
};

type NotificationsContextValue = {
  notifications: AppNotification[];
  unreadCount: number;
  permission: NotificationPermission | 'unsupported';
  browserNotificationsEnabled: boolean;
  feedbackNotificationsEnabled: boolean;
  requestPermission: () => Promise<NotificationPermission | 'unsupported'>;
  setBrowserNotificationsEnabled: (enabled: boolean) => void;
  setFeedbackNotificationsEnabled: (enabled: boolean) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clearAll: () => void;
};

const NotificationsContext = createContext<NotificationsContextValue>({
  notifications: [],
  unreadCount: 0,
  permission: 'unsupported',
  browserNotificationsEnabled: true,
  feedbackNotificationsEnabled: true,
  requestPermission: async () => 'unsupported',
  setBrowserNotificationsEnabled: () => {},
  setFeedbackNotificationsEnabled: () => {},
  markAllRead: () => {},
  markRead: () => {},
  clearAll: () => {},
});

function fromApi(n: ApiNotification): AppNotification {
  return {
    id: n.id,
    type: n.type as AppNotificationType,
    title: n.title,
    message: n.message,
    href: n.href ?? undefined,
    createdAt: new Date(n.createdAt).getTime(),
    read: !!n.readAt,
  };
}

export function dispatchbasefyioNotification(payload: NotifyPayload) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(BASEFYIO_NOTIFY_EVENT, { detail: payload }));
}

export function useNotifications() {
  return useContext(NotificationsContext);
}

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] = useState(true);
  const [feedbackNotificationsEnabled, setFeedbackNotificationsEnabled] = useState(true);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );
  const { activeImport, modalShowingImport } = useImportProgress();
  const lastImportNotifiedRef = useRef<string | null>(null);
  // Ids already shown; null until the first load, so old rows never pop up as browser alerts.
  const knownIds = useRef<Set<string> | null>(null);

  // Local state first, DB in the background; a failed call is retried by the next reload's list.
  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    void api.notifications.markAllRead().catch(() => {});
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
    void api.notifications.markRead(id).catch(() => {});
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
    void api.notifications.clear().catch(() => {});
  }, []);

  const showBrowserNotification = useCallback(
    (n: AppNotification) => {
      if (
        !browserNotificationsEnabled ||
        typeof window === 'undefined' ||
        !('Notification' in window) ||
        Notification.permission !== 'granted'
      ) {
        return;
      }
      try {
        const browserNotification = new Notification(n.title, {
          body: n.message,
          tag: `basefyio-${n.type}-${n.href ?? ''}`,
        });
        // Opening the browser notification is a real read.
        browserNotification.onclick = () => {
          markRead(n.id);
          window.focus();
          if (n.href) window.location.href = n.href;
        };
      } catch {
        // Ignore browser notification errors; in-app feed still works.
      }
    },
    [browserNotificationsEnabled, markRead],
  );

  // The API stores every bell notification when it is emitted; the browser only reads the list.
  const refresh = useCallback(() => {
    api.notifications
      .list()
      .then((r) => {
        const items = r.items.map(fromApi);
        const known = knownIds.current;
        knownIds.current = new Set(items.map((n) => n.id));
        setNotifications(items);
        if (known) items.filter((n) => !n.read && !known.has(n.id)).forEach(showBrowserNotification);
      })
      .catch(() => {});
  }, [showBrowserNotification]);

  const requestPermission = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported';
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, []);

  useEffect(() => {
    if (!getAccessToken()) {
      setCurrentUserId(null);
      return;
    }
    api.auth
      .getProfile()
      .then((p) => setCurrentUserId(p.id))
      .catch(() => setCurrentUserId(null));
  }, []);

  useEffect(() => {
    if (!currentUserId || typeof window === 'undefined') return;
    const browserPref = window.localStorage.getItem(`basefyio_browser_notifications_enabled_${currentUserId}`);
    const feedbackPref = window.localStorage.getItem(`basefyio_feedback_notifications_enabled_${currentUserId}`);
    setBrowserNotificationsEnabled(browserPref !== '0');
    setFeedbackNotificationsEnabled(feedbackPref !== '0');
  }, [currentUserId]);

  const saveBrowserPreference = useCallback(
    (enabled: boolean) => {
      setBrowserNotificationsEnabled(enabled);
      if (currentUserId && typeof window !== 'undefined') {
        window.localStorage.setItem(`basefyio_browser_notifications_enabled_${currentUserId}`, enabled ? '1' : '0');
      }
    },
    [currentUserId],
  );

  const saveFeedbackPreference = useCallback(
    (enabled: boolean) => {
      setFeedbackNotificationsEnabled(enabled);
      if (currentUserId && typeof window !== 'undefined') {
        window.localStorage.setItem(`basefyio_feedback_notifications_enabled_${currentUserId}`, enabled ? '1' : '0');
      }
    },
    [currentUserId],
  );

  useEffect(() => {
    // Keep refs/reads to avoid unused values and maintain compatibility.
    void activeImport;
    void modalShowingImport;
    void lastImportNotifiedRef;
  }, [activeImport, modalShowingImport]);

  // Load the stored list (and so the unread badge) once the user is known.
  useEffect(() => {
    if (currentUserId) refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserId]);

  // A realtime push means the API has just stored a row for this user; re-read the list.
  useEffect(() => {
    if (!currentUserId || !feedbackNotificationsEnabled) return;
    const unsubscribe = subscribebasefyioRealtime(`user:${currentUserId}`, (e) => {
      if (['feedback', 'feedback_comment', 'project'].includes(e.entityType)) refresh();
    });
    return () => {
      unsubscribe?.();
    };
  }, [currentUserId, feedbackNotificationsEnabled, refresh]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  return (
    <NotificationsContext.Provider
      value={{
        notifications,
        unreadCount,
        permission,
        browserNotificationsEnabled,
        feedbackNotificationsEnabled,
        requestPermission,
        setBrowserNotificationsEnabled: saveBrowserPreference,
        setFeedbackNotificationsEnabled: saveFeedbackPreference,
        markAllRead,
        markRead,
        clearAll,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}
