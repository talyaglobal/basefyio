import { baseLayout } from './base.template';

export function projectWelcomeTemplate(data: {
  email: string;
  projectName: string;
}): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-green">&#127881;</div>
        </div>
        <h1 class="greeting">Welcome to ${data.projectName}!</h1>
        <p class="text">
          Your email has been verified and your account is now fully active.
          You can start using <strong>${data.projectName}</strong> right away.
        </p>

        <div class="info-card">
          <div class="info-card-title">Your Account</div>
          <div class="info-card-value">${data.email}</div>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          If you have any questions, feel free to reach out to the ${data.projectName} team.
        </p>
      </div>`;

  return baseLayout(content);
}
