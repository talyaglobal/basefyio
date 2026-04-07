'use client';

import { Bell, CheckCheck, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useNotifications } from '@/lib/notifications-context';

function formatRelative(ts: number) {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function NotificationsBell() {
  const {
    notifications,
    unreadCount,
    permission,
    requestPermission,
    markAllRead,
    markRead,
    clearAll,
  } = useNotifications();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label="Notifications"
          title="Notifications"
        >
          <Bell className="h-4 w-4" />
          {unreadCount > 0 && (
            <span className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold text-white">
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[360px]">
        <DropdownMenuLabel className="flex items-center justify-between">
          <span>Notifications</span>
          <span className="text-xs font-normal text-muted-foreground">
            {permission === 'granted' ? 'Browser alerts on' : 'Browser alerts off'}
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {permission !== 'granted' && permission !== 'unsupported' && (
          <>
            <DropdownMenuItem onClick={() => void requestPermission()}>
              Enable browser notifications
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {notifications.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted-foreground">
            No notifications yet.
          </div>
        ) : (
          <div className="max-h-[340px] overflow-y-auto">
            {notifications.map((n) => (
              <DropdownMenuItem
                key={n.id}
                className="flex cursor-pointer items-start gap-2 py-2"
                onClick={() => {
                  markRead(n.id);
                  if (n.href) window.location.href = n.href;
                }}
              >
                <div className={`mt-1 h-2 w-2 rounded-full ${n.read ? 'bg-muted' : 'bg-primary'}`} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{n.title}</p>
                  <p className="line-clamp-2 text-xs text-muted-foreground">{n.message}</p>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {formatRelative(n.createdAt)}
                </span>
              </DropdownMenuItem>
            ))}
          </div>
        )}
        <DropdownMenuSeparator />
        <div className="flex items-center justify-end gap-1 p-1">
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={markAllRead}>
            <CheckCheck className="mr-1 h-3.5 w-3.5" />
            Mark all read
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 text-xs" onClick={clearAll}>
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Clear
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
