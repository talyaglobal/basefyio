'use client';

import { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export interface PlanOption {
  id: string;
  name: string;
  displayName: string;
  priceMonthly: number;
}

type Scheduled = {
  plan: PlanOption;
  effectiveAt: string;
  nextCharge: number;
};

const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

/**
 * "Cancel" on the current plan card: choose another plan instead of only
 * leaving. A more expensive plan goes to the usual upgrade dialog; a cheaper
 * paid plan waits for the end of the paid period; Free goes through the move
 * to Free (its checks and blockers).
 */
export function PlanChangeDialog({
  open,
  onOpenChange,
  teamId,
  plans,
  currentPlan,
  onUpgrade,
  onMoveToFree,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamId: string | null;
  plans: PlanOption[];
  currentPlan: PlanOption | null;
  onUpgrade: (plan: PlanOption) => void;
  onMoveToFree: () => void;
  onChanged: () => void;
}) {
  const [checking, setChecking] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<Scheduled | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    if (!open) {
      setScheduled(null);
      setChecking(null);
    }
  }, [open]);

  const current = currentPlan?.priceMonthly ?? 0;
  const others = plans.filter((p) => p.name !== currentPlan?.name);
  const paidOthers = others.filter((p) => p.priceMonthly > 0).sort((a, b) => b.priceMonthly - a.priceMonthly);
  const free = others.find((p) => p.name === 'free');

  const choose = async (plan: PlanOption) => {
    if (!teamId) return;
    if (plan.priceMonthly > current) {
      onOpenChange(false);
      onUpgrade(plan);
      return;
    }
    setChecking(plan.name);
    try {
      const preview = await api.billing.previewCheaperPlan(teamId, plan.name);
      if (preview.kind === 'scheduled') {
        setScheduled({ plan, effectiveAt: preview.effectiveAt, nextCharge: preview.nextCharge });
      } else {
        // No paid period running: buying the cheaper plan now is an ordinary plan change.
        onOpenChange(false);
        onUpgrade(plan);
      }
    } catch (err: any) {
      toast.error(err.message || 'Could not check this plan change');
    } finally {
      setChecking(null);
    }
  };

  const confirm = async () => {
    if (!teamId || !scheduled) return;
    setConfirming(true);
    try {
      const res = await api.billing.changePlan(teamId, scheduled.plan.name);
      toast.success(res.message);
      onOpenChange(false);
      onChanged();
    } catch (err: any) {
      toast.error(err.message || 'Could not change the plan');
    } finally {
      setConfirming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{scheduled ? `Move to ${scheduled.plan.displayName}` : 'Change or cancel your plan'}</DialogTitle>
          <DialogDescription>
            {scheduled
              ? 'Nothing is charged or refunded today.'
              : `You are on ${currentPlan?.displayName ?? 'your plan'}. Pick the plan you want instead.`}
          </DialogDescription>
        </DialogHeader>

        {scheduled ? (
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              You keep <span className="font-medium text-foreground">{currentPlan?.displayName}</span> until{' '}
              <span className="font-medium text-foreground">{formatDate(scheduled.effectiveAt)}</span>, the end of the
              period you paid for. Then your plan moves to{' '}
              <span className="font-medium text-foreground">{scheduled.plan.displayName}</span> and{' '}
              <span className="font-medium text-foreground">{money(scheduled.nextCharge)}/mo</span> is charged.
            </p>
            <p className="text-muted-foreground">You can undo this from the billing page until then.</p>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setScheduled(null)} disabled={confirming}>
                Back
              </Button>
              <Button onClick={confirm} disabled={confirming}>
                {confirming ? 'Scheduling…' : `Move to ${scheduled.plan.displayName}`}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            {paidOthers.map((plan) => {
              const up = plan.priceMonthly > current;
              return (
                <button
                  key={plan.id}
                  type="button"
                  onClick={() => choose(plan)}
                  disabled={checking !== null}
                  className="flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left text-sm transition-colors hover:border-primary/50 hover:bg-muted/40 disabled:opacity-60"
                >
                  <span className="flex items-center gap-2">
                    {up ? <ArrowUp className="h-4 w-4 text-primary" /> : <ArrowDown className="h-4 w-4 text-muted-foreground" />}
                    <span>
                      <span className="font-medium text-foreground">{up ? 'Upgrade' : 'Switch'} to {plan.displayName}</span>
                      <span className="block text-xs text-muted-foreground">
                        {up ? 'Starts now; the unused part of your plan is credited.' : 'Starts when your paid period ends.'}
                      </span>
                    </span>
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {checking === plan.name ? 'Checking…' : `${money(plan.priceMonthly)}/mo`}
                  </span>
                </button>
              );
            })}
            {free && (
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  onMoveToFree();
                }}
                disabled={checking !== null}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-destructive/40 p-3 text-left text-sm transition-colors hover:bg-destructive/5 disabled:opacity-60"
              >
                <span className="flex items-center gap-2">
                  <ArrowDown className="h-4 w-4 text-destructive" />
                  <span>
                    <span className="font-medium text-destructive">Downgrade to Free</span>
                    <span className="block text-xs text-muted-foreground">
                      Ends the paid plan when the period ends. Usage must fit the Free limits.
                    </span>
                  </span>
                </span>
                <span className="shrink-0 text-muted-foreground">$0/mo</span>
              </button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
