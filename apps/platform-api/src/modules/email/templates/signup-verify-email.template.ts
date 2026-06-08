import { baseLayout } from './base.template';

interface SignupVerifyEmailData {
  email: string;
  otp: string;
  firstName?: string;
}

export function signupVerifyEmailTemplate(data: SignupVerifyEmailData): string {
  const greeting = data.firstName ? `Hi ${data.firstName},` : 'Hi there,';

  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#9993;</div>
        </div>
        <h1 class="greeting">Verify your email</h1>
        <p class="text">
          ${greeting} You're signing up for <strong>Basefyio</strong>.
          Please enter the code below to verify your email and complete registration.
        </p>

        <div class="info-card" style="text-align: center;">
          <div class="info-card-title">Your Verification Code</div>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; font-family: monospace; padding: 8px 0;">
            ${data.otp}
          </div>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          This code expires in 10 minutes. If you didn't sign up for Basefyio, you can safely ignore this email.
        </p>
      </div>`;

  return baseLayout(content);
}
