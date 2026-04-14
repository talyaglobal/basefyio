import { baseLayout } from './base.template';

interface SignInData {
  displayName: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string;
  dashboardUrl: string;
}

export function signInTemplate(data: SignInData): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#128274;</div>
        </div>
        <h1 class="greeting">New sign-in detected</h1>
        <p class="text">
          Hello <strong>${data.displayName}</strong>, we noticed a new sign-in to your
          Kolaybase account. If this was you, no action is needed.
        </p>

        <div class="info-card">
          <div class="info-card-title">Sign-in Details</div>
          <table style="width: 100%; border-collapse: collapse;">
            <tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Time</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right;">${data.timestamp}</td>
            </tr>
            ${
              data.ipAddress
                ? `<tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">IP Address</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right;">${data.ipAddress}</td>
            </tr>`
                : ''
            }
            ${
              data.userAgent
                ? `<tr>
              <td style="padding: 6px 0; font-size: 14px; color: #64748b;">Device</td>
              <td style="padding: 6px 0; font-size: 14px; font-weight: 500; color: #0f172a; text-align: right; font-size: 12px; max-width: 200px; word-break: break-word;">${data.userAgent}</td>
            </tr>`
                : ''
            }
          </table>
        </div>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 32px auto;">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${data.dashboardUrl}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="21%" strokecolor="#2563eb" fillcolor="#2563eb">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">Open Dashboard</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${data.dashboardUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">Open Dashboard</a>
              <!--<![endif]-->
            </td>
          </tr>
        </table>

        <div class="divider"></div>

        <div style="background-color: #fef3c7; border-radius: 10px; padding: 16px 20px; border-left: 4px solid #f59e0b;">
          <p style="font-size: 14px; color: #92400e; margin: 0; line-height: 1.6;">
            <strong>Not you?</strong> If you didn't sign in, please change your
            password immediately and contact our support team.
          </p>
        </div>
      </div>`;

  return baseLayout(content);
}
