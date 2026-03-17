import { baseLayout } from './base.template';

interface ProjectVerifyEmailData {
  email: string;
  projectName: string;
  verifyUrl: string;
  otp: string;
}

export function projectVerifyEmailTemplate(data: ProjectVerifyEmailData): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#9993;</div>
        </div>
        <h1 class="greeting">Verify your email</h1>
        <p class="text">
          You signed up for <strong>${data.projectName}</strong>.
          Please confirm your email address to complete your registration.
        </p>

        <div class="info-card" style="text-align: center;">
          <div class="info-card-title">Your Verification Code</div>
          <div style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #2563eb; font-family: monospace; padding: 8px 0;">
            ${data.otp}
          </div>
        </div>

        <p class="text" style="text-align: center; font-size: 13px; color: #94a3b8;">
          Or click the button below to verify directly:
        </p>

        <table role="presentation" border="0" cellpadding="0" cellspacing="0" style="margin: 24px auto;">
          <tr>
            <td align="center" bgcolor="#2563eb" style="border-radius: 10px;">
              <!--[if mso]>
              <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${data.verifyUrl}" style="height:48px;v-text-anchor:middle;width:240px;" arcsize="21%" strokecolor="#2563eb" fillcolor="#2563eb">
                <w:anchorlock/>
                <center style="color:#ffffff;font-family:sans-serif;font-size:15px;font-weight:bold;">Verify Email</center>
              </v:roundrect>
              <![endif]-->
              <!--[if !mso]><!-->
              <a href="${data.verifyUrl}" target="_blank" style="display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;">Verify Email</a>
              <!--<![endif]-->
            </td>
          </tr>
        </table>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          This code expires in 24 hours. If you didn't create an account, you can safely ignore this email.
        </p>
      </div>`;

  return baseLayout(content);
}
