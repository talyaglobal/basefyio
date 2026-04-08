'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useImportProgress } from '@/lib/import-progress-context';
import { getAccessToken } from '@/lib/auth';

export const KB_NOTIFY_EVENT = 'kb-notify-event';

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
  addNotification: (payload: NotifyPayload) => void;
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
  addNotification: () => {},
  markAllRead: () => {},
  markRead: () => {},
  clearAll: () => {},
});

function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function dispatchKbNotification(payload: NotifyPayload) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(KB_NOTIFY_EVENT, { detail: payload }));
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
  const lastFeedbackRef = useRef<
    Record<
      string,
      {
        status: string;
        commentCount: number;
        title: string;
        description: string;
        deletedAt: string;
      }
    >
  >({});
  const lastFeedbackEventRef = useRef<Record<string, string>>({});
  const isFirstFeedbackScanRef = useRef(true);
  const { activeImport, modalShowingImport } = useImportProgress();
  const lastImportNotifiedRef = useRef<string | null>(null);

  const addNotification = useCallback((payload: NotifyPayload) => {
    if (payload.type === 'feedback' && !feedbackNotificationsEnabled) return;

    const entry: AppNotification = {
      id: uid(),
      type: payload.type,
      title: payload.title,
      message: payload.message,
      createdAt: Date.now(),
      href: payload.href,
      read: false,
    };

    setNotifications((prev) => [entry, ...prev].slice(0, 50));

    if (
      browserNotificationsEnabled &&
      typeof window !== 'undefined' &&
      'Notification' in window &&
      Notification.permission === 'granted'
    ) {
      try {
        const browserNotification = new Notification(payload.title, {
          body: payload.message,
          tag: `kb-${payload.type}-${payload.href ?? ''}`,
        });
        if (payload.href) {
          browserNotification.onclick = () => {
            window.focus();
            window.location.href = payload.href!;
          };
        }
      } catch {
        // Ignore browser notification errors; in-app feed still works.
      }
    }
  }, [browserNotificationsEnabled, feedbackNotificationsEnabled]);

  const markAllRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read: true } : n)));
  }, []);

  const clearAll = useCallback(() => {
    setNotifications([]);
  }, []);

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
    const browserPref = window.localStorage.getItem(`kb_browser_notifications_enabled_${currentUserId}`);
    const feedbackPref = window.localStorage.getItem(`kb_feedback_notifications_enabled_${currentUserId}`);
    setBrowserNotificationsEnabled(browserPref !== '0');
    setFeedbackNotificationsEnabled(feedbackPref !== '0');
  }, [currentUserId]);

  const saveBrowserPreference = useCallback(
    (enabled: boolean) => {
      setBrowserNotificationsEnabled(enabled);
      if (currentUserId && typeof window !== 'undefined') {
        window.localStorage.setItem(`kb_browser_notifications_enabled_${currentUserId}`, enabled ? '1' : '0');
      }
    },
    [currentUserId],
  );

  const saveFeedbackPreference = useCallback(
    (enabled: boolean) => {
      setFeedbackNotificationsEnabled(enabled);
      if (currentUserId && typeof window !== 'undefined') {
        window.localStorage.setItem(`kb_feedback_notifications_enabled_${currentUserId}`, enabled ? '1' : '0');
      }
    },
    [currentUserId],
  );

  useEffect(() => {
    const onAppNotify = (event: Event) => {
      const detail = (event as CustomEvent<NotifyPayload>).detail;
      if (!detail?.title || !detail?.message || !detail?.type) return;
      // "Incoming only": AI/import notifications are always initiated from the same user session.
      if (detail.type === 'ai' || detail.type === 'import') return;
      addNotification(detail);
    };
    window.addEventListener(KB_NOTIFY_EVENT, onAppNotify as EventListener);
    return () => window.removeEventListener(KB_NOTIFY_EVENT, onAppNotify as EventListener);
  }, [addNotification]);

  useEffect(() => {
    // Keep refs/reads to avoid unused values and maintain compatibility.
    void activeImport;
    void modalShowingImport;
    void lastImportNotifiedRef;
  }, [activeImport, modalShowingImport]);

  useEffect(() => {
    if (!getAccessToken()) {
      return;
    }
    if (!feedbackNotificationsEnabled) {
      return;
    }
    let cancelled = false;

    const poll = async () => {
      try {
        const list = await api.feedback.list();
        if (cancelled) return;

        const current: Record<
          string,
          { status: string; commentCount: number; title: string; description: string; deletedAt: string }
        > = {};
        for (const item of list) {
          current[item.id] = {
            status: item.status,
            commentCount: Array.isArray(item.comments) ? item.comments.length : 0,
            title: item.title || '',
            description: item.description || '',
            deletedAt: item.deletedAt || '',
          };
        }

        if (!isFirstFeedbackScanRef.current) {
          for (const item of list) {
            const prev = lastFeedbackRef.current[item.id];
            if (!prev) continue;
            if (prev.status !== item.status) {
              let statusChangedByOther = true;
              if (currentUserId) {
                try {
                  const history = await api.feedback.history(item.id);
                  const latestStatus = history.find((h) => h.action === 'STATUS_CHANGED');
                  statusChangedByOther = !!latestStatus && latestStatus.userId !== currentUserId;
                } catch {
                  statusChangedByOther = false;
                }
              }
              if (statusChangedByOther) {
                addNotification({
                  type: 'feedback',
                  title: 'Feedback status updated',
                  message: `"${item.title}" is now ${item.status.replace('_', ' ').toLowerCase()}.`,
                  href: `/dashboard/feedbacks#feedback-${item.id}`,
                });
              }
            }

            const hasOtherMutation =
              prev.title !== (item.title || '') ||
              prev.description !== (item.description || '') ||
              prev.deletedAt !== (item.deletedAt || '');
            if (hasOtherMutation && currentUserId) {
              try {
                const history = await api.feedback.history(item.id);
                const latest = history[0];
                if (latest && latest.id !== lastFeedbackEventRef.current[item.id]) {
                  lastFeedbackEventRef.current[item.id] = latest.id;
                  if (latest.userId !== currentUserId) {
                    addNotification({
                      type: 'feedback',
                      title: 'Feedback updated by another user',
                      message: `"${item.title}" was updated by ${latest.username}.`,
                      href: `/dashboard/feedbacks#feedback-${item.id}`,
                    });
                  }
                }
              } catch {
                // ignore history fetch issues
              }
            }
            const nextCount = Array.isArray(item.comments) ? item.comments.length : 0;
            if (nextCount > prev.commentCount) {
              const allComments = Array.isArray(item.comments) ? item.comments : [];
              const newComments = allComments.slice(prev.commentCount);
              const incomingComments = currentUserId
                ? newComments.filter((c) => c.userId !== currentUserId)
                : newComments;
              if (incomingComments.length > 0) {
                addNotification({
                  type: 'feedback',
                  title: 'New feedback comment',
                  message: `${incomingComments.length} new comment on "${item.title}".`,
                  href: `/dashboard/feedbacks#feedback-${item.id}`,
                });
              }
            }
          }
        } else {
          isFirstFeedbackScanRef.current = false;
        }

        lastFeedbackRef.current = current;
      } catch {
        // Keep polling quietly.
      }
    };

    void poll();
    const id = window.setInterval(() => void poll(), 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [addNotification, currentUserId, feedbackNotificationsEnabled]);

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
        addNotification,
        markAllRead,
        markRead,
        clearAll,
      }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}
