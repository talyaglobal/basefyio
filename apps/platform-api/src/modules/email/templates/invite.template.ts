import { baseLayout } from './base.template';

interface InviteData {
  invitedUsername: string;
  inviterUsername: string;
  teamName: string;
  acceptUrl: string;
  dashboardUrl: string;
}

export function inviteTemplate(data: InviteData): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#129309;</div>
        </div>
        <h1 class="greeting">You've been invited!</h1>
        <p class="text">
          Hello <strong>${data.invitedUsername}</strong>,
          <strong>${data.inviterUsername}</strong> has invited you to join the
          <strong>${data.teamName}</strong> team on Kolaybase.
        </p>

        <div style="background: linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%); border-radius: 12px; padding: 28px; margin: 24px 0; text-align: center;">
          <div style="font-size: 13px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; margin-bottom: 8px;">
            Team
          </div>
          <div style="font-size: 24px; font-weight: 700; color: #0f172a; margin-bottom: 4px;">
            ${data.teamName}
          </div>
          <div style="font-size: 14px; color: #64748b;">
            Invited by ${data.inviterUsername}
          </div>
        </div>

        <div class="cta-wrapper">
          <a href="${data.acceptUrl}" class="cta-button">
            Accept Invitation &rarr;
          </a>
        </div>

        <p class="text" style="text-align: center; font-size: 13px; color: #94a3b8;">
          Or go to your <a href="${data.dashboardUrl}" style="color: #2563eb; text-decoration: none; font-weight: 500;">dashboard</a>
          to view all pending invitations.
        </p>

        <div class="divider"></div>

        <div class="info-card">
          <div class="info-card-title">What happens next?</div>
          <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0;">
            Once you accept, you'll have access to all projects and resources
            shared within the <strong>${data.teamName}</strong> team. You can
            also decline the invitation from your dashboard.
          </p>
        </div>
      </div>`;

  return baseLayout(content);
}
