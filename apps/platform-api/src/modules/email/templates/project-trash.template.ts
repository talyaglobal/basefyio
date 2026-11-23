import { baseLayout } from './base.template';

const BUTTON =
  "display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; " +
  "padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, " +
  "'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function hoursText(n: number): string {
  return `${n} ${n === 1 ? 'hour' : 'hours'}`;
}

/** The last notice before a project in the trash is deleted for good (#262). */
export function projectPurgeWarningTemplate(data: {
  projectName: string;
  hoursLeft: number;
  trashUrl: string;
}): string {
  const name = escapeHtml(data.projectName);
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#9888;</div>
        </div>
        <h1 class="greeting">${name} will be deleted permanently</h1>
        <p class="text">
          This project is in the trash. When the trash period ends, its database,
          files, users and keys are deleted and cannot be recovered.
        </p>

        <div class="info-card">
          <div class="info-card-title">Permanent deletion in about</div>
          <div class="info-card-value">${hoursText(data.hoursLeft)}</div>
        </div>

        <p class="text">
          To keep it, open the trash and restore the project before then. If you
          deleted it on purpose, you do not need to do anything.
        </p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${escapeHtml(data.trashUrl)}" target="_blank" style="${BUTTON}">Open the trash</a>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          You are getting this because you created this project or own the organization it belongs to on basefyio.
        </p>
      </div>`;
  return baseLayout(content);
}
