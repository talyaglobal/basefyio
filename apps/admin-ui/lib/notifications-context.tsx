'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { useImportProgress } from '@/lib/import-progress-context';

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
  requestPermission: () => Promise<NotificationPermission | 'unsupported'>;
  addNotification: (payload: NotifyPayload) => void;
  markAllRead: () => void;
  markRead: (id: string) => void;
  clearAll: () => void;
};

const NotificationsContext = createContext<NotificationsContextValue>({
  notifications: [],
  unreadCount: 0,
  permission: 'unsupported',
  requestPermission: async () => 'unsupported',
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
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );
  const lastFeedbackRef = useRef<Record<string, { status: string; commentCount: number }>>({});
  const isFirstFeedbackScanRef = useRef(true);
  const { activeImport, modalShowingImport } = useImportProgress();
  const lastImportNotifiedRef = useRef<string | null>(null);

  const addNotification = useCallback((payload: NotifyPayload) => {
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

    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
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
  }, []);

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
    const onAppNotify = (event: Event) => {
      const detail = (event as CustomEvent<NotifyPayload>).detail;
      if (!detail?.title || !detail?.message || !detail?.type) return;
      addNotification(detail);
    };
    window.addEventListener(KB_NOTIFY_EVENT, onAppNotify as EventListener);
    return () => window.removeEventListener(KB_NOTIFY_EVENT, onAppNotify as EventListener);
  }, [addNotification]);

  useEffect(() => {
    if (!activeImport) return;
    if (activeImport.status !== 'completed') return;
    if (modalShowingImport) return;
    if (lastImportNotifiedRef.current === activeImport.jobId) return;

    addNotification({
      type: 'import',
      title: 'Import completed',
      message: `${activeImport.projectName} import finished successfully.`,
      href: activeImport.projectId ? `/dashboard/projects/${activeImport.projectId}/logs` : '/dashboard/projects',
    });
    lastImportNotifiedRef.current = activeImport.jobId;
  }, [activeImport, modalShowingImport, addNotification]);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const list = await api.feedback.list();
        if (cancelled) return;

        const current: Record<string, { status: string; commentCount: number }> = {};
        for (const item of list) {
          current[item.id] = {
            status: item.status,
            commentCount: Array.isArray(item.comments) ? item.comments.length : 0,
          };
        }

        if (!isFirstFeedbackScanRef.current) {
          for (const item of list) {
            const prev = lastFeedbackRef.current[item.id];
            if (!prev) continue;
            if (prev.status !== item.status) {
              addNotification({
                type: 'feedback',
                title: 'Feedback status updated',
                message: `"${item.title}" is now ${item.status.replace('_', ' ').toLowerCase()}.`,
                href: '/dashboard/feedbacks',
              });
            }
            const nextCount = Array.isArray(item.comments) ? item.comments.length : 0;
            if (nextCount > prev.commentCount) {
              addNotification({
                type: 'feedback',
                title: 'New feedback comment',
                message: `${nextCount - prev.commentCount} new comment on "${item.title}".`,
                href: '/dashboard/feedbacks',
              });
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
  }, [addNotification]);

  const unreadCount = useMemo(() => notifications.filter((n) => !n.read).length, [notifications]);

  return (
    <NotificationsContext.Provider
      value={{
        notifications,
        unreadCount,
        permission,
        requestPermission,
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
