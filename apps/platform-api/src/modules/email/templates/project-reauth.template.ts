import { baseLayout } from './base.template';

export function projectReauthTemplate(data: {
  email: string;
  projectName: string;
  otp: string;
}): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#128274;</div>
        </div>
        <h1 class="greeting">Confirm your identity</h1>
        <p class="text">
          A sensitive action was requested on your <strong>${data.projectName}</strong> account
          (<span style="color: #2563eb;">${data.email}</span>).
          Please enter the code below to confirm.
        </p>

        <div class="info-card" style="text-align: center;">
          <div class="info-card-title">Verification Code</div>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; font-family: monospace; padding: 8px 0;">
            ${data.otp}
          </div>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          This code expires in 10 minutes. If you didn't initiate this action, please secure your account immediately.
        </p>
      </div>`;

  return baseLayout(content);
}
