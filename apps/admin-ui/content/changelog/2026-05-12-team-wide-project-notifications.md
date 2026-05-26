---
date: 2026-05-12
slug: team-wide-project-notifications
title: Project notifications now go to the entire team
kind: feature
version: v1.0.2
summary: When someone creates, deletes, or restores a project, everyone on the team gets notified.
---

Previously, notifications about project creation, deletion, etc. were only sent to admins. Other team members were left out of the loop.

Now every important project change is delivered to everyone on the team:

- **New project created** — "Ahmet created the 'MyWebsite' project."
- **Project updated** — name change, folder move, etc.
- **Project deleted** — "Ahmet moved the 'MyWebsite' project to trash."
- **Project restored** — "Ahmet restored the 'MyWebsite' project."

Clicking the notification takes you directly to the relevant project.

## Details

- The person who performed the action doesn't receive a notification — they already know what they did.
- You only see notifications for your own team's projects, not other teams'.
- Even if real-time notifications are disabled, the app works normally — you'll just see changes by refreshing the page.
