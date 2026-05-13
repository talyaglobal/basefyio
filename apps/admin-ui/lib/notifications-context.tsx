'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useImportProgress } from '@/lib/import-progress-context';
import { getAccessToken } from '@/lib/auth';
import { subscribeKbRealtime } from '@/lib/kb-realtime';
import type { RealtimeEventEnvelope } from '@/lib/realtime-types';

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

  // Realtime notifications are the single source of truth now — the legacy
  // 15-second polling loop that diffed /feedback list + attributed via
  // /feedback/:id/history has been retired. The SSE payload from
  // FeedbackService carries `actorName`, `actorUserId`, `commentPreview` and
  // diff flags, which is everything the polling loop used to look up
  // out-of-band. Set NEXT_PUBLIC_KB_REALTIME_DISABLE=1 to fall back to the
  // server-side polling state (the subscribe call returns null and no
  // notifications fire — better than waking up the browser unnecessarily).
  useEffect(() => {
    if (!currentUserId || !feedbackNotificationsEnabled) return;

    const unsubscribe = subscribeKbRealtime(
      `user:${currentUserId}`,
      (event: RealtimeEventEnvelope) => {
        // Self-edits never produce a toast; the actor already knows what they did.
        if (event.actorUserId && event.actorUserId === currentUserId) return;

        const actor =
          (event.payload && typeof event.payload.actorName === 'string'
            ? event.payload.actorName
            : null) || 'Someone';

        if (event.entityType === 'feedback' && event.action === 'status_changed') {
          const title =
            typeof event.payload?.title === 'string' ? event.payload.title : 'a feedback';
          const to =
            typeof event.payload?.to === 'string'
              ? event.payload.to.replace('_', ' ').toLowerCase()
              : 'updated';
          addNotification({
            type: 'feedback',
            title: 'Feedback status updated',
            message: `${actor} marked "${title}" as ${to}.`,
            href: `/dashboard/feedbacks#feedback-${event.entityId}`,
          });
        } else if (
          event.entityType === 'feedback_comment' &&
          event.action === 'comment_added'
        ) {
          const feedbackId = event.payload?.feedbackId;
          const title =
            typeof event.payload?.feedbackTitle === 'string'
              ? event.payload.feedbackTitle
              : 'a feedback';
          const preview =
            typeof event.payload?.commentPreview === 'string'
              ? event.payload.commentPreview
              : null;
          addNotification({
            type: 'feedback',
            title: 'New feedback comment',
            message: preview
              ? `${actor} on "${title}": ${preview}`
              : `${actor} commented on "${title}".`,
            href: feedbackId
              ? `/dashboard/feedbacks#feedback-${String(feedbackId)}`
              : '/dashboard/feedbacks',
          });
        } else if (event.entityType === 'feedback' && event.action === 'updated') {
          const title =
            typeof event.payload?.title === 'string' ? event.payload.title : 'a feedback';
          addNotification({
            type: 'feedback',
            title: 'Feedback updated',
            message: `${actor} updated "${title}".`,
            href: `/dashboard/feedbacks#feedback-${event.entityId}`,
          });
        } else if (event.entityType === 'feedback' && event.action === 'deleted') {
          const title =
            typeof event.payload?.title === 'string' ? event.payload.title : 'a feedback';
          addNotification({
            type: 'feedback',
            title: 'Feedback deleted',
            message: `${actor} deleted "${title}".`,
            href: '/dashboard/feedbacks',
          });
        }
      },
    );

    return () => {
      unsubscribe?.();
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
