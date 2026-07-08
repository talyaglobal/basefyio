---
date: 2026-06-29
slug: auth-session-management
title: "Full authentication & session management — a complete Users console"
kind: feature
version: v2.7.0
summary: Project Authentication is now a complete identity console — a richer Users list with a per-user detail panel, realm-wide active sessions with one-click revoke, MFA management, configurable brute-force and password policies, phone numbers, and real client IPs with geolocation.
---

## A real identity console for every project

Project **Authentication** grew from a simple user list into a full identity console — the kind of session and user management you'd expect from a hosted auth provider. It all lives under your project's **Authentication** screen, with new tabs alongside the existing **Users**, **Settings**, **Providers**, and **Email**.

## Users — richer list + per-user detail drawer

The **Users** table now shows everything at a glance:

- **Copyable UID** — grab any user's ID with one click
- **Phone** number
- **Email confirmed** status
- **Created** date and account status

Click any row to open a **detail drawer** with the full picture of one user:

- User UID, email-confirmed state, phone & phone-verified, status
- **Created** and **last signed in** timestamps
- **Active session count** and the user's **sign-in providers** (email + any linked OAuth identities such as Google or GitHub)
- One-click actions: **Edit**, **Set password**, **Send password recovery**, **Send verification email**, **Require MFA enrollment**, and **Delete user**
- The user's own **session list** with per-session **Revoke** and **Sign out of all sessions**

## Sessions — see and control who is signed in

A new **Sessions** tab lists **every active session across all users** in the project, showing the user, IP address, **location**, the clients in use, and start / last-access times. You can **revoke any session** instantly.

To make this genuinely useful:

- **Real client IPs** — SDK sign-in and sign-up now forward the end user's real IP to the auth server, so sessions record the actual client address instead of an internal service address.
- **Geolocation** — each session is annotated with a best-effort **City, Country** derived from its IP (private addresses are shown as `internal`). New sessions created after this release will show real IPs and locations.

## MFA — multi-factor authentication management

A new **MFA** tab lists every user with an enrolled factor (authenticator app / security key), showing the factor type and enrollment date. From here you can:

- **Remove a factor** to reset a user's MFA (they'll re-enroll on next login)
- **Require MFA enrollment** for any user from their detail drawer — they'll be prompted to set up an authenticator at their next sign-in

## Policies — brute-force protection & password rules

A new **Policies** tab writes security policy straight to your project:

- **Brute-force / lockout** — enable protection and tune max login failures, wait increments, maximum wait, and permanent lockout
- **Password policy** — minimum length, required character classes (uppercase, lowercase, digit, special), **password history** (how many previous passwords are remembered), and **expiry** in days

## Quality of life

- The user detail panel now opens as a proper overlay that layers correctly above the top navigation.

Open **Authentication → Sessions** in any project, sign in from another device, and watch the session — with its location — appear. Then try **Revoke** or **Sign out of all sessions**.
