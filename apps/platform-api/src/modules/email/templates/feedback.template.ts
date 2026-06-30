import { baseLayout } from './base.template';

interface FeedbackData {
  displayName: string;
  email: string;
  url: string;
  title: string;
  description?: string;
  type: string;
  createdAt: string;
  attachments?: { url: string; mimeType: string; kind: string }[];
}

export function feedbackTemplate(data: FeedbackData): string {
  const attachmentsHtml =
    data.attachments && data.attachments.length > 0
      ? `<div class="info-card" style="margin-top:16px;">
          <div class="info-card-title">Attachments</div>
          <ul style="margin:8px 0 0; padding-left:16px;">
            ${data.attachments
              .map(
                (a) =>
                  `<li style="font-size:13px; color:#475569; line-height:1.6;">
                     <a href="${a.url}" style="color:#2563eb; text-decoration:none;">${a.kind}</a>
                     (${a.mimeType})
                   </li>`,
              )
              .join('')}
          </ul>
        </div>`
      : '';

  const content = `
    <div class="body">
      <h1 class="greeting">New Feedback Received</h1>
      <div class="info-card">
        <div class="info-card-title">Feedback Details</div>
        <table style="width:100%; border-collapse:collapse; font-size:14px; color:#475569;">
          <tr>
            <td style="padding:6px 0; font-weight:600; width:120px;">From:</td>
            <td style="padding:6px 0;">${data.displayName} (${data.email})</td>
          </tr>
          <tr>
            <td style="padding:6px 0; font-weight:600;">Type:</td>
            <td style="padding:6px 0;">${data.type}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; font-weight:600;">Title:</td>
            <td style="padding:6px 0;">${data.title}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; font-weight:600;">Date:</td>
            <td style="padding:6px 0;">${data.createdAt}</td>
          </tr>
          <tr>
            <td style="padding:6px 0; font-weight:600;">URL:</td>
            <td style="padding:6px 0;"><a href="${data.url}" style="color:#2563eb;">${data.url}</a></td>
          </tr>
        </table>
      </div>

      ${
        data.description
          ? `<div class="info-card" style="margin-top:16px;">
               <div class="info-card-title">Description</div>
               <p style="font-size:14px; color:#475569; line-height:1.6; margin:8px 0 0; white-space:pre-wrap;">${data.description}</p>
             </div>`
          : ''
      }

      ${attachmentsHtml}
    </div>`;

  return baseLayout(content);
}
