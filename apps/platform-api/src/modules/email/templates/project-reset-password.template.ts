import { baseLayout } from './base.template';

interface ProjectResetPasswordData {
  email: string;
  projectName: string;
  otp: string;
}

export function projectResetPasswordTemplate(data: ProjectResetPasswordData): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#128274;</div>
        </div>
        <h1 class="greeting">Reset your password</h1>
        <p class="text">
          We received a password reset request for your <strong>${data.projectName}</strong> account
          (<span style="color: #2563eb;">${data.email}</span>).
        </p>

        <div class="info-card" style="text-align: center;">
          <div class="info-card-title">Your Reset Code</div>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; font-family: monospace; padding: 8px 0;">
            ${data.otp}
          </div>
        </div>

        <p class="text" style="font-size: 13px; color: #94a3b8; text-align: center;">
          Enter this code in the app to set a new password.
        </p>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          This code expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.
        </p>
      </div>`;

  return baseLayout(content);
}
