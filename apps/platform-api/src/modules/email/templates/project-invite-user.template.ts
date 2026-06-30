import { baseLayout } from './base.template';

export function projectInviteUserTemplate(data: {
  email: string;
  projectName: string;
  inviteUrl: string;
}): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#128233;</div>
        </div>
        <h1 class="greeting">You've been invited!</h1>
        <p class="text">
          You've been invited to join <strong>${data.projectName}</strong>.
          Click the button below to create your account and get started.
        </p>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 24px auto;">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
              <a href="${data.inviteUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">Accept Invitation</a>
            </td>
          </tr>
        </table>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          If you weren't expecting this invitation, you can safely ignore this email.
        </p>
      </div>`;

  return baseLayout(content);
}
