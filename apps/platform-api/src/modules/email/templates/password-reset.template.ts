import { baseLayout } from './base.template';

interface PasswordResetData {
  username: string;
  tempPassword: string;
  projectName: string;
  loginUrl: string;
  setPasswordUrl: string;
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
        migrated to basefyio. A temporary password has been generated for you.
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
          <strong>Important:</strong> We recommend setting a new password for your account.
        </p>
      </div>

      <div class="cta-wrapper" style="text-align: center;">
        <a href="${data.setPasswordUrl}" class="cta-button" style="margin-bottom: 12px;">Set New Password</a>
        <div style="margin-top: 12px;">
          <a href="${data.loginUrl}" style="font-size: 14px; color: #2563eb; text-decoration: none;">
            Or sign in with temporary password &rarr;
          </a>
        </div>
      </div>
      <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 32px auto;">
        <tr>
          <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
            <!--[if mso]>
            <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${data.loginUrl}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="21%" strokecolor="#2563eb" fillcolor="#2563eb">
              <w:anchorlock/>
              <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">Sign In Now</center>
            </v:roundrect>
            <![endif]-->
            <!--[if !mso]><!-->
            <a href="${data.loginUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">Sign In Now</a>
            <!--<![endif]-->
          </td>
        </tr>
      </table>

      <div class="divider"></div>

      <p class="text" style="font-size: 13px; color: #94a3b8;">
        If you did not expect this email, you can safely ignore it. Your account was created as part of
        a project migration to basefyio.
      </p>
    </div>`;

  return baseLayout(content);
}
