import { baseLayout } from './base.template';

/**
 * The two notices an idle project produces: a warning while there is still
 * time to keep it awake, and the confirmation once it has gone to sleep.
 *
 * Both say the same three things, because they are the three a customer
 * actually worries about: nothing has been deleted, waking it takes one
 * click, and here is why it happened.
 */

const BUTTON =
  "display: inline-block; background-color: #2563eb; color: #ffffff; text-decoration: none; " +
  "padding: 14px 36px; border-radius: 10px; font-family: -apple-system, BlinkMacSystemFont, " +
  "'Segoe UI', Roboto, sans-serif; font-size: 15px; font-weight: 600; letter-spacing: 0.2px;";

function days(n: number): string {
  return `${n} ${n === 1 ? 'day' : 'days'}`;
}

export function projectSleepWarningTemplate(data: {
  projectName: string;
  idleDays: number;
  daysLeft: number;
  dashboardUrl: string;
}): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-purple">&#9203;</div>
        </div>
        <h1 class="greeting">${data.projectName} is about to go to sleep</h1>
        <p class="text">
          It has had no API requests for ${days(data.idleDays)}. Projects that stay
          quiet are put to sleep so we are not running a database nobody is
          calling — it keeps the platform fast for everyone and keeps your bill down.
        </p>

        <div class="info-card">
          <div class="info-card-title">If nothing changes, it sleeps in</div>
          <div class="info-card-value">${days(data.daysLeft)}</div>
        </div>

        <p class="text">
          <strong>Nothing is deleted.</strong> Your tables, rows, files and users all
          stay exactly as they are. A sleeping project simply stops answering
          requests until you wake it, which takes one click in the dashboard.
        </p>

        <p class="text">To keep it awake, just use it — a single API call is enough.</p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${data.dashboardUrl}" target="_blank" style="${BUTTON}">Open the project</a>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          You are getting this because you own this project on basefyio.
        </p>
      </div>`;
  return baseLayout(content);
}

export function projectAsleepTemplate(data: {
  projectName: string;
  idleDays: number;
  dashboardUrl: string;
}): string {
  const content = `
      <div class="body">
        <div style="text-align: center;">
          <div class="icon-circle icon-blue">&#128164;</div>
        </div>
        <h1 class="greeting">${data.projectName} is asleep</h1>
        <p class="text">
          It had no API requests for ${days(data.idleDays)}, so we have put it to
          sleep. Its API is not answering right now — anything pointed at it
          will get an error until you wake it.
        </p>

        <p class="text">
          <strong>Nothing has been deleted and nothing will be.</strong> Your database,
          your files and your users are all intact and waiting. Waking the project
          restores it exactly as you left it.
        </p>

        <div style="text-align: center; margin: 28px 0;">
          <a href="${data.dashboardUrl}" target="_blank" style="${BUTTON}">Wake the project</a>
        </div>

        <div class="divider"></div>

        <p class="text" style="font-size: 13px; color: #94a3b8;">
          You are getting this because you own this project on basefyio.
        </p>
      </div>`;
  return baseLayout(content);
}
