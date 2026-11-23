import { baseLayout } from './base.template';

/**
 * The plan usage notice: an organization has used 80% or 100% of a limit that
 * is enforced. Says what the number is, what happens next, and what to do.
 */

const BUTTON =
  "display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; " +
  "padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, " +
  "'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;";

const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function planUsageTemplate(data: {
  teamName: string;
  planName: string;
  label: string;
  current: string;
  limit: string;
  threshold: 80 | 100;
  consequence: string;
  billingUrl: string;
}): string {
  const reached = data.threshold >= 100;
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#9888;</div>
        </div>
        <h1 class="greeting">${escape(data.teamName)} has ${reached ? 'reached' : 'used 80% of'} a plan limit</h1>
        <p class="text">
          ${escape(data.label)} for this organization is at <strong>${escape(data.current)}</strong>
          of the ${escape(data.planName)} plan's <strong>${escape(data.limit)}</strong>.
        </p>

        <div class="info-card">
          <div class="info-card-title">What happens next</div>
          <div class="info-card-value" style="font-size: 15px; font-weight: 500;">${escape(data.consequence)}</div>
        </div>

        <p class="text">
          Nothing is deleted. You can upgrade the plan any time, and the change applies at once.
        </p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${data.billingUrl}" target="_blank" style="${BUTTON}">Open Billing</a>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          You are getting this because you are an owner of this organization on basefyio. We send it once per
          month for each limit and threshold.
        </p>
      </div>`;
  return baseLayout(content);
}
