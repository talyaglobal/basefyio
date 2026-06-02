import { baseLayout } from './base.template';

export interface StripeDailySummaryData {
  date: string;
  totalRevenue: string;
  totalGross: string;
  totalFees: string;
  mrr: string;
  activeSubscriptions: number;
  pastDueSubscriptions: number;
  canceledSubscriptions: number;
  totalCustomers: number;
  recentCharges: {
    date: string;
    customer: string;
    amount: string;
    status: string;
  }[];
  recentInvoices: {
    number: string;
    customer: string;
    amount: string;
    status: string;
    url: string | null;
  }[];
  activeSubscriptionsList: {
    customer: string;
    plan: string;
    amount: string;
    periodEnd: string;
  }[];
}

export function stripeDailySummaryTemplate(data: StripeDailySummaryData): string {
  const statusColor = (s: string) => {
    if (s === 'succeeded' || s === 'paid' || s === 'active') return '#16a34a';
    if (s === 'failed' || s === 'uncollectible') return '#dc2626';
    if (s === 'pending' || s === 'open' || s === 'past_due') return '#d97706';
    return '#64748b';
  };

  const chargeRows = data.recentCharges.slice(0, 15).map((c) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #64748b;">${c.date}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${c.customer}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: right; font-weight: 600;">${c.amount}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">
        <span style="display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: #fff; background-color: ${statusColor(c.status)};">${c.status}</span>
      </td>
    </tr>
  `).join('');

  const invoiceRows = data.recentInvoices.slice(0, 15).map((inv) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; font-family: monospace;">${inv.number}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${inv.customer}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: right; font-weight: 600;">${inv.amount}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">
        <span style="display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; color: #fff; background-color: ${statusColor(inv.status)};">${inv.status}</span>
      </td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">
        ${inv.url ? `<a href="${inv.url}" style="color: #2563eb; text-decoration: none;">View</a>` : '—'}
      </td>
    </tr>
  `).join('');

  const subRows = data.activeSubscriptionsList.slice(0, 20).map((s) => `
    <tr>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${s.customer}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px;">${s.plan}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; text-align: right; font-weight: 600;">${s.amount}</td>
      <td style="padding: 8px 12px; border-bottom: 1px solid #e2e8f0; font-size: 13px; color: #64748b;">${s.periodEnd}</td>
    </tr>
  `).join('');

  const content = `
    <div class="body">
      <div style="text-align: center;">
        <div class="icon-circle icon-green">&#128176;</div>
      </div>
      <h1 class="greeting">Stripe Daily Summary</h1>
      <p class="text" style="text-align: center; color: #64748b;">${data.date}</p>

      <!-- Summary Cards -->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0;">
        <tr>
          <td style="padding: 4px;">
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 10px; padding: 16px; text-align: center;">
              <div style="font-size: 12px; color: #16a34a; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Net Revenue</div>
              <div style="font-size: 24px; font-weight: 700; color: #15803d; margin-top: 4px;">${data.totalRevenue}</div>
            </div>
          </td>
          <td style="padding: 4px;">
            <div style="background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; padding: 16px; text-align: center;">
              <div style="font-size: 12px; color: #2563eb; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">MRR</div>
              <div style="font-size: 24px; font-weight: 700; color: #1d4ed8; margin-top: 4px;">${data.mrr}</div>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 4px;">
            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 16px; text-align: center;">
              <div style="font-size: 12px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Gross</div>
              <div style="font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 4px;">${data.totalGross}</div>
            </div>
          </td>
          <td style="padding: 4px;">
            <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 10px; padding: 16px; text-align: center;">
              <div style="font-size: 12px; color: #dc2626; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Stripe Fees</div>
              <div style="font-size: 20px; font-weight: 700; color: #b91c1c; margin-top: 4px;">${data.totalFees}</div>
            </div>
          </td>
        </tr>
      </table>

      <!-- Subscription Stats -->
      <div class="info-card">
        <div class="info-card-title">Subscriptions</div>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Active</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #16a34a; text-align: right;">${data.activeSubscriptions}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Past Due</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: ${data.pastDueSubscriptions > 0 ? '#d97706' : '#0f172a'}; text-align: right;">${data.pastDueSubscriptions}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Canceled</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a; text-align: right;">${data.canceledSubscriptions}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Total Customers</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a; text-align: right;">${data.totalCustomers}</td>
          </tr>
        </table>
      </div>

      ${chargeRows ? `
      <!-- Recent Charges -->
      <div style="margin-top: 28px;">
        <h2 style="font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 12px;">Recent Charges</h2>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <thead>
            <tr style="background: #f8fafc;">
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Date</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Customer</th>
              <th style="padding: 8px 12px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Amount</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Status</th>
            </tr>
          </thead>
          <tbody>${chargeRows}</tbody>
        </table>
      </div>
      ` : ''}

      ${invoiceRows ? `
      <!-- Recent Invoices -->
      <div style="margin-top: 28px;">
        <h2 style="font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 12px;">Recent Invoices</h2>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <thead>
            <tr style="background: #f8fafc;">
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Invoice</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Customer</th>
              <th style="padding: 8px 12px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Amount</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Status</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Link</th>
            </tr>
          </thead>
          <tbody>${invoiceRows}</tbody>
        </table>
      </div>
      ` : ''}

      ${subRows ? `
      <!-- Active Subscriptions -->
      <div style="margin-top: 28px;">
        <h2 style="font-size: 16px; font-weight: 600; color: #0f172a; margin-bottom: 12px;">Active Subscriptions (${data.activeSubscriptions})</h2>
        <table style="width: 100%; border-collapse: collapse; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
          <thead>
            <tr style="background: #f8fafc;">
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Customer</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Plan</th>
              <th style="padding: 8px 12px; text-align: right; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Amount</th>
              <th style="padding: 8px 12px; text-align: left; font-size: 11px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px;">Period End</th>
            </tr>
          </thead>
          <tbody>${subRows}</tbody>
        </table>
      </div>
      ` : ''}

      <p class="text" style="margin-top: 32px; text-align: center; font-size: 12px; color: #94a3b8;">
        This is an automated daily summary from Kolaybase. View full details in the
        <a href="https://dashboard.stripe.com" style="color: #2563eb; text-decoration: none;">Stripe Dashboard</a>
        or the <a href="https://app.kolaybase.com/dashboard/management" style="color: #2563eb; text-decoration: none;">Management Panel</a>.
      </p>
    </div>
  `;

  return baseLayout(content);
}
