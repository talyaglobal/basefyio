import { baseLayout } from './base.template';

export function projectChangeEmailTemplate(data: {
  email: string;
  newEmail: string;
  projectName: string;
  otp: string;
  confirmUrl: string;
}): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#9993;</div>
        </div>
        <h1 class="greeting">Confirm your new email</h1>
        <p class="text">
          You requested to change your email address on <strong>${data.projectName}</strong>
          to <span style="color: #2563eb;">${data.newEmail}</span>.
        </p>

        <div class="info-card" style="text-align: center;">
          <div class="info-card-title">Confirmation Code</div>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; font-family: monospace; padding: 8px 0;">
            ${data.otp}
          </div>
        </div>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 24px auto;">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
              <a href="${data.confirmUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">Confirm Email Change</a>
            </td>
          </tr>
        </table>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          This code expires in 1 hour. If you didn't request this change, please secure your account immediately.
        </p>
      </div>`;

  return baseLayout(content);
}
