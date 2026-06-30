import { baseLayout } from './base.template';

interface InviteData {
  invitedUsername: string;
  inviterUsername: string;
  teamName: string;
  acceptUrl: string;
  dashboardUrl: string;
  isNewUser?: boolean;
}

export function inviteTemplate(data: InviteData): string {
  const ctaText = data.isNewUser
    ? 'Create Account &amp; Join &rarr;'
    : 'Accept Invitation &rarr;';

  const nextStepText = data.isNewUser
    ? `Create your free basefyio account and you'll automatically see
       the invitation to join <strong>${data.teamName}</strong>. Accept it
       from your dashboard and you're in!`
    : `Once you accept, you'll have access to all projects and resources
       shared within the <strong>${data.teamName}</strong> team. You can
       also decline the invitation from your dashboard.`;

  const footerText = data.isNewUser
    ? `Don't have an account yet? No worries — signing up takes less than a minute.`
    : `Or go to your <a href="${data.dashboardUrl}" style="color: #2563eb; text-decoration: none; font-weight: 500;">dashboard</a>
       to view all pending invitations.`;

  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#129309;</div>
        </div>
        <h1 class="greeting">You've been invited!</h1>
        <p class="text">
          Hello <strong>${data.invitedUsername}</strong>,
          <strong>${data.inviterUsername}</strong> has invited you to join the
          <strong>${data.teamName}</strong> team on basefyio.
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

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 32px auto;">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${data.acceptUrl}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="21%" strokecolor="#2563eb" fillcolor="#2563eb">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">${ctaText}</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${data.acceptUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">${ctaText}</a>
              <!--<![endif]-->
            </td>
          </tr>
        </table>

        <p class="text" style="text-align: center; font-size: 13px; color: #94a3b8;">
          ${footerText}
        </p>

        <div class="divider"></div>

        <div class="info-card">
          <div class="info-card-title">What happens next?</div>
          <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0;">
            ${nextStepText}
          </p>
        </div>
      </div>`;

  return baseLayout(content);
}
