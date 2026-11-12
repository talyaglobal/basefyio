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
  /**
   * For irreversible actions: the user has to type this exact text before
   * the confirm button enables (e.g. the name of what is being deleted).
   */
  confirmPhrase?: string;
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
      if (req.kind === 'prompt') {
        setInputValue(req.options.defaultValue ?? '');
      } else if (req.options.confirmPhrase) {
        setInputValue('');
      }
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
          if (next.kind === 'prompt') {
            setInputValue(next.options.defaultValue ?? '');
          } else {
            setInputValue('');
          }
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

  const confirmPhrase = !isPrompt ? (current.options as ConfirmOptions).confirmPhrase : undefined;
  const phraseMatches = !confirmPhrase || inputValue.trim() === confirmPhrase;
  const handleConfirm = () => {
    if (!phraseMatches) return;
    settle(isPrompt ? inputValue : true);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) settle(isPrompt ? null : false);
      }}
    >
      <DialogContent className="max-w-md" hideClose>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {options.description != null && (
            // overflow-wrap:anywhere rather than break-word: a long unbroken
            // name (a 63-character table name) then wraps instead of widening
            // the dialog and pushing its buttons out of view.
            <DialogDescription className="[overflow-wrap:anywhere]">{options.description}</DialogDescription>
          )}
        </DialogHeader>
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
        {confirmPhrase && (
          <div className="space-y-1.5">
            <label htmlFor="confirm-phrase" className="text-sm text-muted-foreground">
              Type <span className="font-mono font-medium text-foreground [overflow-wrap:anywhere]">{confirmPhrase}</span> to
              confirm
            </label>
            <Input
              id="confirm-phrase"
              autoFocus
              autoComplete="off"
              value={inputValue}
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
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={() => settle(isPrompt ? null : false)}>
            {cancelText}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            autoFocus={!isPrompt && !confirmPhrase}
            disabled={!phraseMatches}
            onClick={handleConfirm}
          >
            {confirmText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
