import { baseLayout } from './base.template';

function escapeHtmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

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
  const typeLabel =
    data.type === 'BUG' ? 'Bug Report' : data.type === 'FEATURE' ? 'Feature Request' : 'General Feedback';

  const typeColor =
    data.type === 'BUG' ? '#ef4444' : data.type === 'FEATURE' ? '#8b5cf6' : '#3b82f6';

  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#128172;</div>
        </div>
        <h1 class="greeting">New Feedback Received</h1>

        <div style="display: inline-block; background-color: ${typeColor}15; color: ${typeColor}; font-size: 12px; font-weight: 600; padding: 4px 12px; border-radius: 100px; margin-bottom: 16px;">
          ${typeLabel}
        </div>

        <div class="info-card">
          <div class="info-card-title">From</div>
          <p class="info-card-value">${data.displayName} (${data.email})</p>
        </div>

        <div class="info-card">
          <div class="info-card-title">Page URL</div>
          <p class="info-card-value" style="word-break: break-all;">${data.url}</p>
        </div>

        <div class="info-card">
          <div class="info-card-title">Title</div>
          <p class="info-card-value">${data.title}</p>
        </div>

        ${data.description ? `
        <div class="info-card">
          <div class="info-card-title">Description</div>
          <p style="font-size: 14px; color: #475569; line-height: 1.6; margin: 0; white-space: pre-wrap;">${data.description}</p>
        </div>` : ''}

        ${data.attachments && data.attachments.length > 0 ? `
        <div class="info-card">
          <div class="info-card-title">Attachments</div>
          <ul style="margin: 0; padding-left: 18px; font-size: 13px; color: #475569;">
            ${data.attachments.map((a) => `<li style="margin-bottom: 6px;"><a href="${escapeHtmlAttr(a.url)}" target="_blank" rel="noopener noreferrer">${a.kind === 'video' ? 'Video' : 'Image'}</a></li>`).join('')}
          </ul>
        </div>` : ''}

        <div class="divider"></div>

        <p class="text" style="text-align: center; font-size: 13px; color: #94a3b8;">
          Submitted on ${data.createdAt}
        </p>
      </div>`;

  return baseLayout(content);
}
