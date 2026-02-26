import { baseLayout } from './base.template';

interface PasswordResetData {
  username: string;
  tempPassword: string;
  projectName: string;
  loginUrl: string;
}

export function passwordResetTemplate(data: PasswordResetData): string {
  const content = `
    <div class="body">
      <div style="text-align: center;">
        <div class="icon-circle icon-purple">&#128274;</div>
      </div>
      <h1 class="greeting">Your account has been migrated</h1>
      <p class="text">
        Hi <strong>${data.username}</strong>, your account from <strong>${data.projectName}</strong> has been
        migrated to Kolaybase. A temporary password has been generated for you.
      </p>

      <div class="info-card">
        <div class="info-card-title">Your Temporary Credentials</div>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Username</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a; text-align: right;">${data.username}</td>
          </tr>
          <tr>
            <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Password</td>
            <td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #0f172a; text-align: right; font-family: monospace; letter-spacing: 1px;">${data.tempPassword}</td>
          </tr>
        </table>
      </div>

      <div style="background-color: #fef3c7; border-radius: 12px; padding: 16px 20px; margin: 24px 0; border-left: 4px solid #f59e0b;">
        <p style="font-size: 14px; color: #92400e; margin: 0;">
          <strong>Important:</strong> Please change your password after your first login for security reasons.
        </p>
      </div>

      <div class="cta-wrapper">
        <a href="${data.loginUrl}" class="cta-button">Sign In Now</a>
      </div>

      <div class="divider"></div>

      <p class="text" style="font-size: 13px; color: #94a3b8;">
        If you did not expect this email, you can safely ignore it. Your account was created as part of
        a project migration to Kolaybase.
      </p>
    </div>`;

  return baseLayout(content);
}
