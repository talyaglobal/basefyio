import { baseLayout } from './base.template';

export function projectMagicLinkTemplate(data: {
  email: string;
  projectName: string;
  magicLinkUrl: string;
  otp: string;
}): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#128279;</div>
        </div>
        <h1 class="greeting">Sign in to ${data.projectName}</h1>
        <p class="text">
          Click the button below to sign in to your <strong>${data.projectName}</strong> account.
          No password needed!
        </p>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 24px auto;">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
              <a href="${data.magicLinkUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">Sign In</a>
            </td>
          </tr>
        </table>

        <div class="info-card" style="text-align: center;">
          <div class="info-card-title">Or use this code</div>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; font-family: monospace; padding: 8px 0;">
            ${data.otp}
          </div>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          This link expires in 10 minutes. If you didn't request this, you can safely ignore this email.
        </p>
      </div>`;

  return baseLayout(content);
}
