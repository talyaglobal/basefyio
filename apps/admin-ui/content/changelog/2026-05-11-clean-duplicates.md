---
date: 2026-05-11
slug: clean-duplicates
title: Clean duplicate rows with a single click
kind: feature
summary: Find duplicate records in your table, see how many will be deleted, and clean them with one click.
---

After bulk data imports, you can end up with duplicate records in your table. The same email address twice, the same product code three times... Cleaning these up manually is both tedious and risky.

Now you can handle it with the **Clean duplicates** button in the Table Editor.

## How to use it?

1. **Which columns to check?** — For example, select the `email` column. Rows with the same email are considered duplicates. You can also select multiple columns, such as `brand + product_code` together.

2. **Preview the count first** — You'll see the answer to "How many rows will be deleted?" before anything is removed.

3. **Clean up** — Confirm, and the duplicate rows are deleted. The oldest record in each group is kept, the rest are removed.

## Things to know

- **Irreversible.** Deleted rows cannot be recovered. Always preview first.
- **Very fast.** Completes in seconds even with millions of rows.
- If there are rows linked to other tables (foreign key), the system will warn you — you'll need to resolve those references first.
