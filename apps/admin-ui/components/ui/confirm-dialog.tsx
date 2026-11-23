'use client';

import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export interface ConfirmOptions {
  title?: string;
  description: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
  /** When set, the confirm button stays disabled until the user types exactly this text (e.g. a project name). */
  requireText?: string;
}

export interface PromptOptions {
  title?: string;
  description?: React.ReactNode;
  placeholder?: string;
  defaultValue?: string;
  confirmText?: string;
  cancelText?: string;
}

type PendingRequest =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

let enqueue: ((req: PendingRequest) => void) | null = null;

/**
 * Drop-in replacement for window.confirm. Resolves true if the user confirms.
 * Requires <ConfirmDialogHost /> to be mounted (done once in the root layout).
 */
export function confirmDialog(options: ConfirmOptions | string): Promise<boolean> {
  const opts = typeof options === 'string' ? { description: options } : options;
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(false);
      return;
    }
    enqueue({ kind: 'confirm', options: opts, resolve });
  });
}

/**
 * Drop-in replacement for window.prompt. Resolves the entered string, or null if cancelled.
 */
export function promptDialog(options: PromptOptions | string): Promise<string | null> {
  const opts = typeof options === 'string' ? { title: options } : options;
  return new Promise((resolve) => {
    if (!enqueue) {
      resolve(null);
      return;
    }
    enqueue({ kind: 'prompt', options: opts, resolve });
  });
}

export function ConfirmDialogHost() {
  const [queue, setQueue] = React.useState<PendingRequest[]>([]);
  const [open, setOpen] = React.useState(false);
  const [inputValue, setInputValue] = React.useState('');
  const current = queue[0] ?? null;

  React.useEffect(() => {
    enqueue = (req) => {
      setQueue((q) => [...q, req]);
      setOpen(true);
      setInputValue(req.kind === 'prompt' ? req.options.defaultValue ?? '' : '');
    };
    return () => {
      enqueue = null;
    };
  }, []);

  const settle = React.useCallback(
    (result: boolean | string | null) => {
      if (!current) return;
      if (current.kind === 'confirm') {
        current.resolve(Boolean(result));
      } else {
        current.resolve(typeof result === 'string' ? result : null);
      }
      setQueue((q) => {
        const rest = q.slice(1);
        if (rest.length > 0) {
          const next = rest[0];
          setInputValue(next.kind === 'prompt' ? next.options.defaultValue ?? '' : '');
        } else {
          setOpen(false);
        }
        return rest;
      });
    },
    [current],
  );

  if (!current) return null;

  const isPrompt = current.kind === 'prompt';
  const options = current.options;
  const destructive = !isPrompt && (current.options as ConfirmOptions).destructive;
  const title = options.title ?? (isPrompt ? 'Enter a value' : 'Are you sure?');
  const confirmText = options.confirmText ?? (isPrompt ? 'OK' : destructive ? 'Delete' : 'Confirm');
  const cancelText = options.cancelText ?? 'Cancel';

  const requireText = !isPrompt ? (current.options as ConfirmOptions).requireText : undefined;
  const typedOk = requireText == null || inputValue.trim() === requireText;
  const handleConfirm = () => {
    if (!typedOk) return;
    settle(isPrompt ? inputValue : true);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(isPrompt ? null : false);
      }}
    >
      <DialogContent className="z-[10000] max-w-md" overlayClassName="z-[10000]" hideClose>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {options.description != null && (
            <DialogDescription className="break-words">{options.description}</DialogDescription>
          )}
        </DialogHeader>
        {requireText != null && (
          <div className="space-y-2">
            <p className="text-sm">
              Type <span className="font-semibold">{requireText}</span> to confirm.
            </p>
            <Input
              autoFocus
              value={inputValue}
              placeholder="Type the name here"
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
            />
          </div>
        )}
        {isPrompt && (
          <Input
            autoFocus
            value={inputValue}
            placeholder={(options as PromptOptions).placeholder}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleConfirm();
              }
            }}
          />
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => settle(isPrompt ? null : false)}>
            {cancelText}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            autoFocus={!isPrompt && requireText == null}
            disabled={!typedOk}
            onClick={handleConfirm}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
