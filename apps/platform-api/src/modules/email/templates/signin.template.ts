import { baseLayout } from './base.template';

interface SignInData {
  username: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string;
  dashboardUrl: string;
}

export function signInTemplate(data: SignInData): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#128274;</div>
        </div>
        <h1 class="greeting">New sign-in detected</h1>
        <p class="text">
          Hello <strong>${data.username}</strong>, we noticed a new sign-in to your
          Kolaybase account. If this was you, no action is needed.
        </p>

        <div class="info-card">
          <div class="info-card-title">Sign-in Details</div>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Time</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right;">${data.timestamp}</td>
            </tr>
            ${
              data.ipAddress
                ? `<tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">IP Address</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right;">${data.ipAddress}</td>
            </tr>`
                : ''
            }
            ${
              data.userAgent
                ? `<tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Device</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right; font-size: 12px; max-width: 200px; word-break: break-word;">${data.userAgent}</td>
            </tr>`
                : ''
            }
          </table>
        </div>

        <div class="cta-wrapper">
          <a href="${data.dashboardUrl}" class="cta-button">
            Open Dashboard
          </a>
        </div>

        <div class="divider"></div>

        <div style="background-color: #fef3c7; border-radius: 10px; padding: 16px 20px; border-left: 4px solid #f59e0b;">
          <p style="font-size: 14px; color: #92400e; margin: 0; line-height: 1.6;">
            <strong>Not you?</strong> If you didn't sign in, please change your
            password immediately and contact our support team.
          </p>
        </div>
      </div>`;

  return baseLayout(content);
}
