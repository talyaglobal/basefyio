import { baseLayout } from './base.template';

interface ForgotPasswordData {
  displayName: string;
  resetUrl: string;
  expiresInMinutes: number;
}

export function forgotPasswordTemplate(data: ForgotPasswordData): string {
  const content = `
    <div class="body">
      <div style="text-align: center;">
        <div class="icon-circle icon-purple">&#128275;</div>
      </div>
      <h1 class="greeting">Reset your password</h1>
      <p class="text">
        Hi <strong>${data.displayName}</strong>, we received a request to reset your password.
        Click the button below to choose a new one.
      </p>

      <div class="cta-wrapper">
        <a href="${data.resetUrl}" class="cta-button">Reset Password</a>
      </div>

      <div class="info-card">
        <div class="info-card-title">Important</div>
        <p style="font-size: 14px; color: #475569; margin: 0;">
          This link will expire in <strong>${data.expiresInMinutes} minutes</strong>.
          If you didn't request a password reset, you can safely ignore this email.
        </p>
      </div>

      <div class="divider"></div>

      <p class="text" style="font-size: 13px; color: #94a3b8;">
        If the button doesn't work, copy and paste this URL into your browser:<br />
        <a href="${data.resetUrl}" style="color: #2563eb; word-break: break-all;">${data.resetUrl}</a>
      </p>
    </div>`;

  return baseLayout(content);
}
