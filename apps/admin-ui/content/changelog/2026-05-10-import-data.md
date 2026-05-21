---
date: 2026-05-10
slug: import-data-wizard
title: Import CSV and Excel files directly into your table
kind: feature
summary: Drag and drop your CSV or Excel files, map the columns, and import. No SQL required.
---

You no longer need to write SQL to import a CSV or Excel file into your table.

Click the **Import Data** button in the Table Editor, drag and drop your file — we'll handle the rest.

## How does it work?

1. **Select your file** — Drag and drop CSV, TSV, or Excel files. Multiple files are supported.

2. **Configure settings** — Column types are auto-detected. Add to an existing table or create a new one. You can manually map which column goes where.

3. **Start the import** — Track how many rows have been written in real time with a live progress bar. You can cancel at any time.

4. **Done!** — See the duration, success rate, and a list of any failed rows.

## What happens if a record already exists?

If your file contains rows that conflict with existing records in the table, we offer three options:

- **Skip** — Keep the existing record, ignore the new one
- **Overwrite** — Update with the new data
- **Raise error** — Stop the operation if a conflict occurs

## Don't worry about large files

Even files hundreds of megabytes in size import without issues. Failed rows are written to a separate report file — you can download it and see why they were rejected.
