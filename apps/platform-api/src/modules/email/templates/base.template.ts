export function baseLayout(content: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>Kolaybase</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap');

    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background-color: #f8fafc;
      color: #1e293b;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    .wrapper {
      width: 100%;
      background-color: #f8fafc;
      padding: 40px 16px;
    }
    .container {
      max-width: 560px;
      margin: 0 auto;
      background-color: #ffffff;
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 1px 2px rgba(0, 0, 0, 0.03);
    }
    .header {
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      padding: 32px 40px;
      text-align: center;
    }
    .logo {
      font-size: 28px;
      font-weight: 700;
      color: #0f172a;
      letter-spacing: -0.5px;
    }
    .logo-wrap {
      display: inline-block;
      padding: 10px 22px;
      border-radius: 999px;
      background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%);
      border: 1px solid #cbd5e1;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
      margin-bottom: 12px;
    }
    .logo-accent {
      color: #60a5fa;
    }
    .body {
      padding: 40px;
    }
    .greeting {
      font-size: 22px;
      font-weight: 600;
      color: #0f172a;
      margin-bottom: 16px;
      line-height: 1.3;
    }
    .text {
      font-size: 15px;
      color: #475569;
      line-height: 1.7;
      margin-bottom: 24px;
    }
    .cta-wrapper {
      text-align: center;
      margin: 32px 0;
    }
    .cta-button {
      display: inline-block;
      background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%);
      color: #ffffff !important;
      text-decoration: none;
      padding: 14px 36px;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      letter-spacing: 0.2px;
      transition: all 0.2s;
    }
    .info-card {
      background-color: #f1f5f9;
      border-radius: 12px;
      padding: 20px 24px;
      margin: 24px 0;
      border-left: 4px solid #2563eb;
    }
    .info-card-title {
      font-size: 13px;
      font-weight: 600;
      color: #64748b;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 8px;
    }
    .info-card-value {
      font-size: 15px;
      font-weight: 500;
      color: #0f172a;
    }
    .divider {
      height: 1px;
      background-color: #e2e8f0;
      margin: 32px 0;
    }
    .footer {
      padding: 24px 40px 32px;
      text-align: center;
      border-top: 1px solid #f1f5f9;
    }
    .footer-text {
      font-size: 13px;
      color: #94a3b8;
      line-height: 1.6;
    }
    .footer-link {
      color: #64748b;
      text-decoration: none;
    }
    .badge {
      display: inline-block;
      background: linear-gradient(135deg, #dbeafe 0%, #ede9fe 100%);
      color: #1e40af;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 12px;
      border-radius: 100px;
      letter-spacing: 0.3px;
      margin-top: 12px;
    }
    .icon-circle {
      display: inline-block;
      width: 56px;
      height: 56px;
      border-radius: 50%;
      text-align: center;
      line-height: 56px;
      font-size: 24px;
      margin-bottom: 20px;
    }
    .icon-blue { background-color: #dbeafe; }
    .icon-green { background-color: #dcfce7; }
    .icon-purple { background-color: #ede9fe; }

    @media only screen and (max-width: 600px) {
      .wrapper { padding: 16px 8px; }
      .header { padding: 24px 20px; }
      .body { padding: 24px 20px; }
      .footer { padding: 20px; }
      .greeting { font-size: 20px; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div class="container">
      <div class="header" style="background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%); padding: 32px 40px; text-align: center;">
        <div class="logo-wrap" style="display: inline-block; padding: 10px 22px; border-radius: 999px; background: linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%); border: 1px solid #cbd5e1; box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7); margin-bottom: 12px;">
          <div class="logo" style="font-size: 28px; font-weight: 700; color: #0f172a; letter-spacing: -0.5px;">Kolay<span class="logo-accent" style="color: #3b82f6;">base</span></div>
        </div>
        <div class="badge" style="display: inline-block; background: linear-gradient(135deg, #dbeafe 0%, #ede9fe 100%); color: #1e40af; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 100px; letter-spacing: 0.3px; margin-top: 12px;">Open-Source Backend Platform</div>
      </div>
      ${content}
      <div class="footer">
        <p class="footer-text">
          &copy; ${new Date().getFullYear()} Kolaybase. All rights reserved.<br />
          <a href="https://kolaybase.com" class="footer-link">kolaybase.com</a>
        </p>
      </div>
    </div>
  </div>
</body>
</html>`.trim();
}
