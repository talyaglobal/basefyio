import { baseLayout } from './base.template';

interface WelcomeData {
  displayName: string;
  email: string;
  loginUrl: string;
  dashboardUrl: string;
}

export function welcomeTemplate(data: WelcomeData): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-green">&#127881;</div>
        </div>
        <h1 class="greeting">Welcome to basefyio, ${data.displayName}!</h1>
        <p class="text">
          Your account has been created successfully. You now have access to a
          powerful open-source backend platform with databases, authentication,
          storage, and real-time APIs.
        </p>

        <div class="info-card">
          <div class="info-card-title">Account Details</div>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Name</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right;">${data.displayName}</td>
            </tr>
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Email</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right;">${data.email}</td>
            </tr>
          </table>
        </div>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 32px auto;">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${data.dashboardUrl}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="21%" strokecolor="#2563eb" fillcolor="#2563eb">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">Go to Dashboard &rarr;</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${data.dashboardUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">Go to Dashboard &rarr;</a>
              <!--<![endif]-->
            </td>
          </tr>
        </table>

        <div class="divider"></div>

        <p class="text" style="font-size: 14px; margin-bottom: 16px;">
          <strong>Here's what you can do next:</strong>
        </p>
        <table style="width: 100%; border-collapse: collapse;">
          <tr>
            <td style="padding: 10px 0; vertical-align: top; width: 32px;">
              <span style="display: inline-block; width: 24px; height: 24px; background: #dbeafe; border-radius: 6px; text-align: center; line-height: 24px; font-size: 12px;">1</span>
            </td>
            <td style="padding: 10px 0; padding-left: 12px;">
              <span style="font-size: 14px; font-weight: 500; color: #0f172a;">Create your first project</span><br />
              <span style="font-size: 13px; color: #64748b;">Set up a database, auth, and storage in seconds</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; vertical-align: top; width: 32px;">
              <span style="display: inline-block; width: 24px; height: 24px; background: #dbeafe; border-radius: 6px; text-align: center; line-height: 24px; font-size: 12px;">2</span>
            </td>
            <td style="padding: 10px 0; padding-left: 12px;">
              <span style="font-size: 14px; font-weight: 500; color: #0f172a;">Invite your team</span><br />
              <span style="font-size: 13px; color: #64748b;">Collaborate with your team members</span>
            </td>
          </tr>
          <tr>
            <td style="padding: 10px 0; vertical-align: top; width: 32px;">
              <span style="display: inline-block; width: 24px; height: 24px; background: #dbeafe; border-radius: 6px; text-align: center; line-height: 24px; font-size: 12px;">3</span>
            </td>
            <td style="padding: 10px 0; padding-left: 12px;">
              <span style="font-size: 14px; font-weight: 500; color: #0f172a;">Connect your app</span><br />
              <span style="font-size: 13px; color: #64748b;">Use our SDK to integrate with any framework</span>
            </td>
          </tr>
        </table>
      </div>`;

  return baseLayout(content);
}
