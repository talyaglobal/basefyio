---
date: 2026-10-08
slug: project-costs
title: "Project costs under Billing"
kind: feature
summary: Billing now breaks the current period down project by project — compute, database storage, file storage, egress and API requests — with running and projected totals.
---

## See what each project costs

**Billing → Project costs** is a new section that shows, for the current
billing period, what every project's usage adds up to:

- **Compute** — each project is sized into a compute tier (Micro, Small,
  Medium, Large, XL) and billed per active hour. Projects on shared
  infrastructure are sized by their database footprint; paused projects stop
  accruing compute.
- **Database and file storage** — per GB-month, prorated to the time the
  project existed inside the period.
- **Egress and API requests** — metered per GB and per million requests.

Each project expands into its line items, and the footer shows **current**
and **projected** costs for the period, with a progress bar for the days left.
**Show usage rates** lists the exact per-hour, per-GB and per-request rates
behind the numbers.

Figures are priced at standard usage rates. Plans are still billed at their
flat monthly price; the breakdown shows how the usage behind that price is
distributed across your projects.

### Behind the scenes

- Usage is now metered **per project** as well as per team: API requests and
  bandwidth are attributed to the project named by the request, database size
  is measured every six hours, and file storage is measured per project by the
  storage pass.
- The team-level **Database Size** meter under Usage now reflects the real
  size of your databases instead of staying at zero.
