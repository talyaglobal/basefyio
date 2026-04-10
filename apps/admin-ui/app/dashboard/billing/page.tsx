'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { CreditCard, Check, AlertTriangle } from 'lucide-react';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, CardElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useDashboard } from '../layout';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

const stripePromise = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
  ? loadStripe(process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY)
  : null;

interface Plan {
  id: string;
  name: string;
  displayName: string;
  maxProjects: number | null;
  maxStorageBytes: string | null;
  maxTeamMembers: number | null;
  maxDbSizeBytes: string | null;
  maxApiRequests: number | null;
  maxBandwidthBytes: string | null;
  maxMau: number | null;
  dedicatedDb: boolean;
  dedicatedStorage: boolean;
  priceMonthly: number;
  features: Record<string, boolean> | null;
}

interface Subscription {
  id: string;
  status: string;
  plan: Plan;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  hasPaymentMethod?: boolean;
  accountStatus?: 'ACTIVE' | 'FROZEN' | 'CANCELLED';
  nextBillingDate?: string | null;
  retryCount?: number;
}

interface Usage {
  projectCount: number;
  storageBytes: string;
  memberCount: number;
  dbSizeBytes: string;
  apiRequestsMonth: number;
  bandwidthMonth: string;
  mauCount: number;
}

interface Invoice {
  id: string;
  stripeInvoiceId?: string | null;
  amountDue: number;
  amountPaid: number;
  currency: string;
  status: string;
  invoiceUrl: string | null;
  invoicePdf: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  createdAt: string;
}

interface UpgradePreview {
  currentPlan: { name: string; displayName: string; priceMonthly: number };
  targetPlan: { name: string; displayName: string; priceMonthly: number };
  currency: string;
  dueNow: number;
  subtotal: number;
  total: number;
  prorationCredit?: number;
  prorationTotal?: number;
  nextPaymentAt?: string | null;
  currentPeriodEnd?: string | null;
  lines: Array<{
    description: string;
    amount: number;
    currency?: string;
    proration?: boolean;
  }>;
}

function formatBytes(bytesStr: string | number | null): string {
  if (!bytesStr) return '0 B';
  const bytes = typeof bytesStr === 'string' ? parseInt(bytesStr, 10) : bytesStr;
  if (bytes === 0) return '0 B';
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${sizes[i]}`;
}

function formatNumber(n: number | null): string {
  if (n === null) return 'Unlimited';
  return n.toLocaleString();
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: (currency || 'usd').toUpperCase(),
  }).format((cents || 0) / 100);
}

function invoiceStatusBadge(status: string) {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'paid') return 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400';
  if (normalized === 'payment_failed' || normalized === 'uncollectible') return 'bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-400';
  if (normalized === 'open' || normalized === 'draft') return 'bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400';
  return 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300';
}

function invoiceStatusLabel(status: string) {
  const normalized = (status || '').toLowerCase();
  if (normalized === 'paid') return 'Paid';
  if (normalized === 'payment_failed') return 'Payment Failed';
  if (normalized === 'uncollectible') return 'Uncollectible';
  if (normalized === 'open') return 'Unpaid';
  if (normalized === 'draft') return 'Draft';
  if (normalized === 'void') return 'Void';
  return status || 'Unknown';
}

function UsageMeter({
  label,
  current,
  max,
  format = 'number',
}: {
  label: string;
  current: number;
  max: number | null;
  format?: 'number' | 'bytes';
}) {
  const percentage = max ? Math.min((current / max) * 100, 100) : 0;
  const isNearLimit = max ? percentage >= 80 : false;
  const isAtLimit = max ? percentage >= 100 : false;

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className={isAtLimit ? 'text-destructive' : isNearLimit ? 'text-amber-500' : 'text-foreground'}>
          {format === 'bytes' ? formatBytes(current) : formatNumber(current)}
          {' / '}
          {max === null ? 'Unlimited' : format === 'bytes' ? formatBytes(max) : formatNumber(max)}
        </span>
      </div>
      {max !== null && (
        <div className="h-2 bg-muted rounded-full overflow-hidden">
          <div
            className={`h-full rounded-full transition-all ${
              isAtLimit ? 'bg-destructive' : isNearLimit ? 'bg-amber-500' : 'bg-primary'
            }`}
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ── Card Form (inside Stripe Elements) ──────────────────

function CardForm({
  teamId,
  onSuccess,
  onCancel,
  autoRetryOnSuccess,
}: {
  teamId: string;
  onSuccess: () => void;
  onCancel: () => void;
  autoRetryOnSuccess?: boolean;
}) {
  const stripe = useStripe();
  const elements = useElements();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!stripe || !elements) return;

    setSaving(true);
    setError(null);

    try {
      const { clientSecret } = await api.billing.createSetupIntent(teamId);

      const cardElement = elements.getElement(CardElement);
      if (!cardElement) throw new Error('Card element not found');

      const { setupIntent, error: stripeError } = await stripe.confirmCardSetup(clientSecret, {
        payment_method: { card: cardElement },
      });

      if (stripeError) {
        setError(stripeError.message || 'Card verification failed');
        return;
      }

      if (setupIntent?.payment_method) {
        await api.billing.attachPaymentMethod(teamId, setupIntent.payment_method as string);
        
        // If account is frozen, automatically retry payment with new card
        if (autoRetryOnSuccess) {
          toast.info('Payment method updated. Retrying payment...');
          try {
            const result = await api.billing.retryPayment(teamId, setupIntent.payment_method as string);
            if (result.success) {
              toast.success('Payment successful! Your account is now active.');
            } else {
              toast.error('Payment retry failed. Please contact support.');
            }
          } catch (retryErr: any) {
            toast.error(retryErr.message || 'Payment retry failed');
          }
        } else {
          toast.success('Payment method added');
        }
        
        onSuccess();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to save card');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="rounded-lg border bg-background p-4">
        <CardElement
          options={{
            style: {
              base: {
                fontSize: '16px',
                color: 'hsl(var(--foreground))',
                '::placeholder': { color: 'hsl(var(--muted-foreground))' },
              },
              invalid: { color: 'hsl(var(--destructive))' },
            },
          }}
        />
      </div>
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <AlertTriangle className="h-4 w-4" />
          {error}
        </div>
      )}
      <div className="flex justify-end gap-3">
        <Button type="button" variant="outline" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" disabled={saving || !stripe}>
          {saving ? 'Saving...' : 'Save Card'}
        </Button>
      </div>
    </form>
  );
}

// ── Main Page ───────────────────────────────────────────

export default function BillingPage() {
  const { activeTeamId } = useDashboard();
  const searchParams = useSearchParams();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [paymentMethod, setPaymentMethod] = useState<{
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null>(null);
  const [billingAccount, setBillingAccount] = useState<any>(null);
  const [editingAccount, setEditingAccount] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);
  const [showCardDialog, setShowCardDialog] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [showUpgradeDialog, setShowUpgradeDialog] = useState(false);
  const [upgradeTargetPlan, setUpgradeTargetPlan] = useState<Plan | null>(null);
  const [upgradePreview, setUpgradePreview] = useState<UpgradePreview | null>(null);
  const [loadingUpgradePreview, setLoadingUpgradePreview] = useState(false);
  const [selectedInvoice, setSelectedInvoice] = useState<Invoice | null>(null);
  const [accountForm, setAccountForm] = useState({
    companyName: '',
    billingEmail: '',
    taxId: '',
    phone: '',
    addressLine1: '',
    city: '',
    state: '',
    postalCode: '',
    country: '',
  });

  const loadData = useCallback(async () => {
    if (!activeTeamId) return;
    setLoading(true);
    try {
      const results = await Promise.allSettled([
        api.billing.plans(),
        api.billing.subscription(activeTeamId),
        api.billing.usage(activeTeamId),
        api.billing.invoices(activeTeamId),
        api.billing.account(activeTeamId),
        api.billing.paymentMethod(activeTeamId),
      ]);

      const val = <T,>(r: PromiseSettledResult<T>, fallback: T): T =>
        r.status === 'fulfilled' ? r.value : fallback;

      setPlans(val(results[0], []) || []);
      setSubscription(val(results[1], null));
      setUsage(val(results[2], null));
      setInvoices(val(results[3], []) || []);
      setBillingAccount(val(results[4], null));
      setPaymentMethod(val(results[5], null));
    } catch (err) {
      console.error('Failed to load billing data:', err);
    } finally {
      setLoading(false);
    }
  }, [activeTeamId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (billingAccount) {
      setAccountForm({
        companyName: billingAccount.companyName || '',
        billingEmail: billingAccount.billingEmail || '',
        taxId: billingAccount.taxId || '',
        phone: billingAccount.phone || '',
        addressLine1: billingAccount.addressLine1 || '',
        city: billingAccount.city || '',
        state: billingAccount.state || '',
        postalCode: billingAccount.postalCode || '',
        country: billingAccount.country || '',
      });
    }
  }, [billingAccount]);

  const success = searchParams.get('success');
  const canceled = searchParams.get('canceled');

  const handleChangePlan = async (planName: string) => {
    if (!activeTeamId) return;
    setChangingPlan(planName);
    try {
      await api.billing.changePlan(activeTeamId, planName);
      toast.success(`Plan changed to ${planName}`);
      setShowUpgradeDialog(false);
      setUpgradeTargetPlan(null);
      setUpgradePreview(null);
      loadData();
    } catch (err: any) {
      toast.error(err.message || 'Failed to change plan');
    } finally {
      setChangingPlan(null);
    }
  };

  const handleOpenUpgradeDialog = async (plan: Plan) => {
    if (!activeTeamId) return;
    setUpgradeTargetPlan(plan);
    setShowUpgradeDialog(true);
    setLoadingUpgradePreview(true);
    setUpgradePreview(null);
    try {
      const preview = await api.billing.previewPlanChange(activeTeamId, plan.name);
      setUpgradePreview(preview);
    } catch (err: any) {
      toast.error(err.message || 'Failed to load upgrade preview');
      setShowUpgradeDialog(false);
      setUpgradeTargetPlan(null);
    } finally {
      setLoadingUpgradePreview(false);
    }
  };

  const handleCancel = async () => {
    if (!activeTeamId) return;
    setCanceling(true);
    try {
      await api.billing.cancelSubscription(activeTeamId);
      toast.success('Subscription will cancel at end of billing period');
      loadData();
    } catch (err: any) {
      toast.error(err.message || 'Failed to cancel subscription');
    } finally {
      setCanceling(false);
    }
  };

  const handleResume = async () => {
    if (!activeTeamId) return;
    setResuming(true);
    try {
      await api.billing.resumeSubscription(activeTeamId);
      toast.success('Subscription resumed');
      loadData();
    } catch (err: any) {
      toast.error(err.message || 'Failed to resume subscription');
    } finally {
      setResuming(false);
    }
  };

  const handleSaveBillingAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeTeamId) return;
    setSavingAccount(true);
    try {
      const result = await api.billing.updateAccount(activeTeamId, accountForm);
      setBillingAccount(result);
      setEditingAccount(false);
      toast.success('Billing details saved');
    } catch (err: any) {
      toast.error(err.message || 'Failed to save billing details');
    } finally {
      setSavingAccount(false);
    }
  };

  if (loading) {
    return (
      <div className="p-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-muted rounded w-48" />
          <div className="h-64 bg-muted rounded" />
        </div>
      </div>
    );
  }

  const currentPlan = subscription?.plan;
  const isLegacy = currentPlan?.name === 'legacy';
  const isFree = currentPlan?.name === 'free';
  const isPaid = currentPlan && !isLegacy && !isFree;

  return (
    <div className="max-w-6xl mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-foreground">Billing</h1>
        <p className="text-muted-foreground mt-1">Manage your subscription, usage, and invoices</p>
      </div>

      {/* Alerts */}
      {success && (
        <div className="p-4 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg text-emerald-700 dark:text-emerald-300">
          Subscription upgraded successfully! Your new plan is now active.
        </div>
      )}
      {canceled && (
        <div className="p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg text-amber-700 dark:text-amber-300">
          Checkout was canceled. No changes were made.
        </div>
      )}

      {/* Account Status Alerts */}
      {subscription?.accountStatus === 'FROZEN' && (
        <div className="p-6 bg-red-950/40 border border-red-800/50 rounded-xl space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-red-200">Account Suspended</h3>
              <p className="text-sm text-red-300 mt-1">
                Your account has been suspended due to failed payment attempts. Update your payment method and retry to restore access.
              </p>
              {subscription.retryCount && subscription.retryCount > 0 && (
                <p className="text-xs text-red-400 mt-2">
                  Failed payment attempts: {subscription.retryCount}/3
                </p>
              )}
            </div>
          </div>
          <Button
            onClick={() => setShowCardDialog(true)}
            className="bg-red-600 hover:bg-red-500"
          >
            Update Payment Method & Retry
          </Button>
        </div>
      )}

      {subscription?.status === 'PAST_DUE' && subscription?.accountStatus !== 'FROZEN' && (
        <div className="p-6 bg-amber-950/40 border border-amber-800/50 rounded-xl space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-5 w-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1">
              <h3 className="font-semibold text-amber-200">Payment Failed</h3>
              <p className="text-sm text-amber-300 mt-1">
                Your last payment attempt failed. Please update your payment method to avoid service interruption.
              </p>
              {subscription.retryCount && subscription.retryCount > 0 && (
                <p className="text-xs text-amber-400 mt-2">
                  Retry attempt {subscription.retryCount}/3. Account will be suspended after 3 failed attempts.
                </p>
              )}
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => setShowCardDialog(true)}
            className="border-amber-600 text-amber-400 hover:bg-amber-950/50"
          >
            Update Payment Method
          </Button>
        </div>
      )}

      {/* Current Plan */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">Current Plan</h2>
            <div className="flex items-center gap-3 mt-2">
              <span className="text-3xl font-bold text-foreground">
                {currentPlan?.displayName || 'No Plan'}
              </span>
              {isLegacy && (
                <span className="px-2 py-0.5 text-xs bg-purple-100 dark:bg-purple-900/50 text-purple-700 dark:text-purple-300 rounded-full border border-purple-200 dark:border-purple-700">
                  Grandfathered
                </span>
              )}
              {isPaid && (
                <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded-full border border-primary/20">
                  ${((currentPlan?.priceMonthly || 0) / 100).toFixed(0)}/mo
                </span>
              )}
            </div>
            {subscription?.cancelAtPeriodEnd && subscription.currentPeriodEnd && (
              <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
                Cancels at end of period: {new Date(subscription.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {isPaid && subscription?.stripeSubscriptionId && !subscription.cancelAtPeriodEnd && (
              <Button variant="outline" size="sm" onClick={handleCancel} disabled={canceling}>
                {canceling ? 'Canceling...' : 'Cancel Subscription'}
              </Button>
            )}
            {subscription?.cancelAtPeriodEnd && (
              <Button size="sm" onClick={handleResume} disabled={resuming}>
                {resuming ? 'Resuming...' : 'Resume Subscription'}
              </Button>
            )}
          </div>
        </div>

        {currentPlan && (
          <div className="mt-4 flex flex-wrap gap-2">
            {currentPlan.dedicatedDb && (
              <span className="px-3 py-1 text-xs bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 rounded-full border border-emerald-200 dark:border-emerald-800">
                Dedicated Database
              </span>
            )}
            {currentPlan.dedicatedStorage && (
              <span className="px-3 py-1 text-xs bg-emerald-50 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 rounded-full border border-emerald-200 dark:border-emerald-800">
                Dedicated Storage
              </span>
            )}
            {currentPlan.features && typeof currentPlan.features === 'object' && (
              <>
                {(currentPlan.features as Record<string, boolean>).dailyBackups && (
                  <span className="px-3 py-1 text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 rounded-full border border-blue-200 dark:border-blue-800">
                    Daily Backups
                  </span>
                )}
                {(currentPlan.features as Record<string, boolean>).prioritySupport && (
                  <span className="px-3 py-1 text-xs bg-blue-50 dark:bg-blue-950/30 text-blue-700 dark:text-blue-400 rounded-full border border-blue-200 dark:border-blue-800">
                    Priority Support
                  </span>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Payment Method */}
      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Payment Method</h2>
        {paymentMethod ? (
          <div className="flex items-center gap-4">
            <div className="p-3 bg-muted rounded-lg">
              <CreditCard className="w-6 h-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-foreground font-medium">
                {paymentMethod.brand?.toUpperCase()} •••• {paymentMethod.last4}
              </p>
              <p className="text-sm text-muted-foreground">
                Expires {paymentMethod.expMonth}/{paymentMethod.expYear}
              </p>
            </div>
            <Button variant="outline" size="sm" className="ml-auto" onClick={() => setShowCardDialog(true)}>
              Update Card
            </Button>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <p className="text-muted-foreground">No payment method on file</p>
            <Button onClick={() => setShowCardDialog(true)}>
              <CreditCard className="w-4 h-4 mr-2" />
              Add Payment Method
            </Button>
          </div>
        )}
      </div>

      {/* Card Dialog */}
      <Dialog open={showCardDialog} onOpenChange={setShowCardDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{paymentMethod ? 'Update Payment Method' : 'Add Payment Method'}</DialogTitle>
            <DialogDescription>
              Enter your card details. Your card will be securely saved for future billing.
            </DialogDescription>
          </DialogHeader>
          {stripePromise ? (
            <Elements stripe={stripePromise}>
              <CardForm
                teamId={activeTeamId}
                onSuccess={() => {
                  setShowCardDialog(false);
                  loadData();
                }}
                onCancel={() => setShowCardDialog(false)}
                autoRetryOnSuccess={subscription?.accountStatus === 'FROZEN'}
              />
            </Elements>
          ) : (
            <p className="text-muted-foreground text-sm py-4">
              Stripe is not configured. Please set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY.
            </p>
          )}
        </DialogContent>
      </Dialog>

      {/* Billing Details */}
      <div className="rounded-xl border bg-card p-6">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-lg font-semibold text-foreground">Billing Details</h2>
          {!editingAccount && billingAccount && (
            <Button variant="outline" size="sm" onClick={() => setEditingAccount(true)}>
              Edit
            </Button>
          )}
        </div>

        {editingAccount || !billingAccount ? (
          <form onSubmit={handleSaveBillingAccount} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Company Name</label>
                <input
                  type="text"
                  value={accountForm.companyName}
                  onChange={(e) => setAccountForm({ ...accountForm, companyName: e.target.value })}
                  className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  placeholder="Acme Inc."
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Billing Email</label>
                <input
                  type="email"
                  value={accountForm.billingEmail}
                  onChange={(e) => setAccountForm({ ...accountForm, billingEmail: e.target.value })}
                  className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  placeholder="billing@example.com"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Tax ID / VAT Number</label>
                <input
                  type="text"
                  value={accountForm.taxId}
                  onChange={(e) => setAccountForm({ ...accountForm, taxId: e.target.value })}
                  className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  placeholder="EU123456789"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Phone</label>
                <input
                  type="tel"
                  value={accountForm.phone}
                  onChange={(e) => setAccountForm({ ...accountForm, phone: e.target.value })}
                  className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  placeholder="+1 234 567 8900"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm text-muted-foreground mb-1">Address</label>
                <input
                  type="text"
                  value={accountForm.addressLine1}
                  onChange={(e) => setAccountForm({ ...accountForm, addressLine1: e.target.value })}
                  className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary"
                  placeholder="123 Main St"
                />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">City</label>
                <input type="text" value={accountForm.city} onChange={(e) => setAccountForm({ ...accountForm, city: e.target.value })} className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary" />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">State / Region</label>
                <input type="text" value={accountForm.state} onChange={(e) => setAccountForm({ ...accountForm, state: e.target.value })} className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary" />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Postal Code</label>
                <input type="text" value={accountForm.postalCode} onChange={(e) => setAccountForm({ ...accountForm, postalCode: e.target.value })} className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary" />
              </div>
              <div>
                <label className="block text-sm text-muted-foreground mb-1">Country</label>
                <input type="text" value={accountForm.country} onChange={(e) => setAccountForm({ ...accountForm, country: e.target.value })} className="w-full px-3 py-2 bg-background border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary" placeholder="US" />
              </div>
            </div>
            <div className="flex gap-3">
              <Button type="submit" disabled={savingAccount}>
                {savingAccount ? 'Saving...' : 'Save Billing Details'}
              </Button>
              {billingAccount && (
                <Button type="button" variant="outline" onClick={() => setEditingAccount(false)}>
                  Cancel
                </Button>
              )}
            </div>
          </form>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            {billingAccount.companyName && (
              <div><span className="text-muted-foreground">Company:</span> <span className="ml-1 text-foreground">{billingAccount.companyName}</span></div>
            )}
            {billingAccount.billingEmail && (
              <div><span className="text-muted-foreground">Email:</span> <span className="ml-1 text-foreground">{billingAccount.billingEmail}</span></div>
            )}
            {billingAccount.taxId && (
              <div><span className="text-muted-foreground">Tax ID:</span> <span className="ml-1 text-foreground">{billingAccount.taxId}</span></div>
            )}
            {billingAccount.phone && (
              <div><span className="text-muted-foreground">Phone:</span> <span className="ml-1 text-foreground">{billingAccount.phone}</span></div>
            )}
            {(billingAccount.addressLine1 || billingAccount.city) && (
              <div className="md:col-span-2">
                <span className="text-muted-foreground">Address:</span>
                <span className="ml-1 text-foreground">
                  {[billingAccount.addressLine1, billingAccount.city, billingAccount.state, billingAccount.postalCode, billingAccount.country].filter(Boolean).join(', ')}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Usage */}
      {usage && currentPlan && (
        <div className="rounded-xl border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Usage</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <UsageMeter label="Projects" current={usage.projectCount} max={currentPlan.maxProjects} />
            <UsageMeter label="Team Members" current={usage.memberCount} max={currentPlan.maxTeamMembers} />
            <UsageMeter label="Storage" current={parseInt(usage.storageBytes || '0', 10)} max={currentPlan.maxStorageBytes ? parseInt(currentPlan.maxStorageBytes, 10) : null} format="bytes" />
            <UsageMeter label="Database Size" current={parseInt(usage.dbSizeBytes || '0', 10)} max={currentPlan.maxDbSizeBytes ? parseInt(currentPlan.maxDbSizeBytes, 10) : null} format="bytes" />
            <UsageMeter label="API Requests (this month)" current={usage.apiRequestsMonth} max={currentPlan.maxApiRequests} />
            <UsageMeter label="Bandwidth (this month)" current={parseInt(usage.bandwidthMonth || '0', 10)} max={currentPlan.maxBandwidthBytes ? parseInt(currentPlan.maxBandwidthBytes, 10) : null} format="bytes" />
          </div>
        </div>
      )}

      {/* Plans */}
      {!isLegacy && (
        <div>
          <h2 className="text-lg font-semibold text-foreground mb-4">
            {isFree ? 'Upgrade Your Plan' : 'Available Plans'}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {plans.map((plan) => {
              const isCurrent = currentPlan?.name === plan.name;
              const currentPrice = currentPlan?.priceMonthly || 0;
              const canUpgrade = !isCurrent && plan.priceMonthly > currentPrice;

              return (
                <div
                  key={plan.id}
                  className={`rounded-xl border bg-card p-6 transition-colors ${
                    isCurrent ? 'border-primary ring-1 ring-primary/20' : 'hover:border-primary/40'
                  }`}
                >
                  <div className="flex justify-between items-start">
                    <h3 className="text-lg font-semibold text-foreground">{plan.displayName}</h3>
                    {isCurrent && (
                      <span className="px-2 py-0.5 text-xs bg-primary/10 text-primary rounded-full">Current</span>
                    )}
                  </div>
                  <div className="mt-2">
                    <span className="text-3xl font-bold text-foreground">${(plan.priceMonthly / 100).toFixed(0)}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                  <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" />{plan.maxProjects === null ? 'Unlimited' : plan.maxProjects} projects</li>
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" />{plan.maxStorageBytes === null ? 'Unlimited' : formatBytes(plan.maxStorageBytes)} storage</li>
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" />{plan.maxTeamMembers === null ? 'Unlimited' : plan.maxTeamMembers} team members</li>
                    <li className="flex items-center gap-2"><Check className="h-3.5 w-3.5 text-primary" />{plan.maxApiRequests === null ? 'Unlimited' : formatNumber(plan.maxApiRequests)} API req/mo</li>
                    {plan.dedicatedDb && <li className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400"><Check className="h-3.5 w-3.5" />Dedicated Database</li>}
                    {plan.dedicatedStorage && <li className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400"><Check className="h-3.5 w-3.5" />Dedicated Storage</li>}
                  </ul>
                  {canUpgrade && (
                    <Button
                      className="mt-6 w-full"
                      variant="default"
                      onClick={() => handleOpenUpgradeDialog(plan)}
                      disabled={changingPlan === plan.name}
                    >
                      {changingPlan === plan.name ? 'Changing...' : 'Upgrade'}
                    </Button>
                  )}
                  {isCurrent && (
                    <div className="mt-6 w-full py-2 text-center text-sm text-muted-foreground">Your current plan</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Invoices */}
      <div className="rounded-xl border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No invoices yet. Once billing events occur, paid/unpaid invoice records will appear here.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground border-b">
                  <th className="pb-3 pr-4 font-medium">Date</th>
                  <th className="pb-3 pr-4 font-medium">Invoice</th>
                  <th className="pb-3 pr-4 font-medium">Period</th>
                  <th className="pb-3 pr-4 font-medium">Amount</th>
                  <th className="pb-3 pr-4 font-medium">Outstanding</th>
                  <th className="pb-3 pr-4 font-medium">Status</th>
                  <th className="pb-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => {
                  const outstanding = Math.max(inv.amountDue - inv.amountPaid, 0);
                  return (
                    <tr
                      key={inv.id}
                      className="border-b last:border-0 align-top cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={() => setSelectedInvoice(inv)}
                    >
                      <td className="py-3 pr-4 text-foreground">
                        {new Date(inv.createdAt).toLocaleString()}
                      </td>
                      <td className="py-3 pr-4 text-primary hover:underline">
                        {inv.stripeInvoiceId || inv.id.slice(0, 8)}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {inv.periodStart && inv.periodEnd
                          ? `${new Date(inv.periodStart).toLocaleDateString()} - ${new Date(inv.periodEnd).toLocaleDateString()}`
                          : 'N/A'}
                      </td>
                      <td className="py-3 pr-4 text-foreground">
                        <div className="font-medium">{formatMoney(inv.amountDue, inv.currency)}</div>
                        <div className="text-xs text-muted-foreground">
                          Paid: {formatMoney(inv.amountPaid, inv.currency)}
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={outstanding > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}>
                          {formatMoney(outstanding, inv.currency)}
                        </span>
                      </td>
                      <td className="py-3 pr-4">
                        <span className={`px-2 py-0.5 text-xs rounded-full ${invoiceStatusBadge(inv.status)}`}>
                          {invoiceStatusLabel(inv.status)}
                        </span>
                      </td>
                      <td className="py-3">
                        <div className="flex gap-3" onClick={(e) => e.stopPropagation()}>
                          {inv.invoiceUrl && (
                            <a href={inv.invoiceUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">View</a>
                          )}
                          {inv.invoicePdf && (
                            <a href={inv.invoicePdf} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">PDF</a>
                          )}
                          {!inv.invoiceUrl && !inv.invoicePdf && (
                            <button
                              type="button"
                              className="text-primary hover:underline"
                              onClick={(e) => { e.stopPropagation(); setSelectedInvoice(inv); }}
                            >
                              Details
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Invoice Detail Dialog */}
      <Dialog open={!!selectedInvoice} onOpenChange={(open) => { if (!open) setSelectedInvoice(null); }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Invoice Details</DialogTitle>
            <DialogDescription>
              {selectedInvoice?.stripeInvoiceId || selectedInvoice?.id.slice(0, 8)}
            </DialogDescription>
          </DialogHeader>
          {selectedInvoice && (() => {
            const outstanding = Math.max(selectedInvoice.amountDue - selectedInvoice.amountPaid, 0);
            return (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground">Status</p>
                    <span className={`inline-block mt-1 px-2 py-0.5 text-xs rounded-full ${invoiceStatusBadge(selectedInvoice.status)}`}>
                      {invoiceStatusLabel(selectedInvoice.status)}
                    </span>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Date</p>
                    <p className="font-medium text-foreground">{new Date(selectedInvoice.createdAt).toLocaleString()}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Invoice ID</p>
                    <p className="font-mono text-xs text-foreground break-all">{selectedInvoice.stripeInvoiceId || selectedInvoice.id}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground">Billing Period</p>
                    <p className="text-foreground">
                      {selectedInvoice.periodStart && selectedInvoice.periodEnd
                        ? `${new Date(selectedInvoice.periodStart).toLocaleDateString()} - ${new Date(selectedInvoice.periodEnd).toLocaleDateString()}`
                        : 'N/A'}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border p-4 space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Amount Due</span>
                    <span className="font-medium text-foreground">{formatMoney(selectedInvoice.amountDue, selectedInvoice.currency)}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Amount Paid</span>
                    <span className="font-medium text-emerald-600 dark:text-emerald-400">{formatMoney(selectedInvoice.amountPaid, selectedInvoice.currency)}</span>
                  </div>
                  <div className="border-t pt-2">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium text-foreground">Outstanding Balance</span>
                      <span className={`font-bold ${outstanding > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                        {formatMoney(outstanding, selectedInvoice.currency)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="flex justify-end gap-2">
                  {selectedInvoice.invoiceUrl && (
                    <a href={selectedInvoice.invoiceUrl} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline" size="sm">View on Stripe</Button>
                    </a>
                  )}
                  {selectedInvoice.invoicePdf && (
                    <a href={selectedInvoice.invoicePdf} target="_blank" rel="noopener noreferrer">
                      <Button variant="outline" size="sm">Download PDF</Button>
                    </a>
                  )}
                  <Button variant="outline" size="sm" onClick={() => setSelectedInvoice(null)}>
                    Close
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      {/* Upgrade Confirmation Dialog */}
      <Dialog
        open={showUpgradeDialog}
        onOpenChange={(open) => {
          setShowUpgradeDialog(open);
          if (!open) {
            setUpgradeTargetPlan(null);
            setUpgradePreview(null);
            setLoadingUpgradePreview(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Confirm Upgrade</DialogTitle>
            <DialogDescription>
              Review prorated billing details before moving to a higher plan.
            </DialogDescription>
          </DialogHeader>

          {loadingUpgradePreview && (
            <div className="space-y-2 py-2 text-sm text-muted-foreground">
              <div className="h-4 w-48 animate-pulse rounded bg-muted" />
              <div className="h-4 w-64 animate-pulse rounded bg-muted" />
              <div className="h-20 w-full animate-pulse rounded bg-muted" />
            </div>
          )}

          {!loadingUpgradePreview && upgradePreview && (
            <div className="space-y-4">
              <div className="rounded-lg border bg-muted/30 p-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Current plan</span>
                  <span className="font-medium text-foreground">
                    {upgradePreview.currentPlan.displayName} ({formatMoney(upgradePreview.currentPlan.priceMonthly, upgradePreview.currency)}/mo)
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between">
                  <span className="text-muted-foreground">New plan</span>
                  <span className="font-medium text-foreground">
                    {upgradePreview.targetPlan.displayName} ({formatMoney(upgradePreview.targetPlan.priceMonthly, upgradePreview.currency)}/mo)
                  </span>
                </div>
              </div>

              {/* Billing Breakdown */}
              <div className="rounded-lg border bg-card p-4 space-y-2 text-sm">
                <h4 className="font-medium text-foreground">Billing Breakdown</h4>
                {upgradePreview.lines.map((line, idx) => (
                  <div key={idx} className="flex items-center justify-between py-1">
                    <span className={line.proration ? 'text-muted-foreground' : 'text-foreground'}>
                      {line.description}
                    </span>
                    <span className={line.proration ? 'text-emerald-600 dark:text-emerald-400' : 'text-foreground'}>
                      {line.proration ? '-' : ''}{formatMoney(line.amount, upgradePreview.currency)}
                    </span>
                  </div>
                ))}
              </div>

              <div className="rounded-lg border bg-emerald-50 dark:bg-emerald-950/20 p-4 text-sm">
                <p className="text-muted-foreground">Amount Due Today</p>
                <p className="mt-1 text-3xl font-bold text-foreground">
                  {formatMoney(upgradePreview.dueNow, upgradePreview.currency)}
                </p>
                {(upgradePreview.prorationCredit ?? 0) > 0 && (
                  <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">
                    {formatMoney(upgradePreview.prorationCredit ?? 0, upgradePreview.currency)} credit applied from your current plan.
                  </p>
                )}
                {upgradePreview.nextPaymentAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Next billing date: {new Date(upgradePreview.nextPaymentAt).toLocaleDateString()}
                  </p>
                )}
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-700 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <p>
                  Your plan will be upgraded immediately and {formatMoney(upgradePreview.dueNow, upgradePreview.currency)} will be charged to your payment method now.
                </p>
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setShowUpgradeDialog(false);
                    setUpgradeTargetPlan(null);
                    setUpgradePreview(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  onClick={() => upgradeTargetPlan && handleChangePlan(upgradeTargetPlan.name)}
                  disabled={!upgradeTargetPlan || changingPlan === upgradeTargetPlan.name}
                >
                  {changingPlan === upgradeTargetPlan?.name ? 'Upgrading...' : 'Confirm Upgrade'}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
