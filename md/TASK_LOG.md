# Task Log

## 2026-03-27
- Added table name `Search tables...` input to `TableEditor` sidebar, and filter table list by name (no effect on row filter).
- Fixed Supabase import warnings flow so tables with `0 rows imported` are also appended to import `warnings` (shown in result dialog + overview import log).
- Import complete modal: primary action navigates to `/dashboard/projects/[id]` for the imported project; persist `projectId` in import progress context/localStorage for resume.
- Overview import log: merge `project.supabaseImportLog` with per-browser `localStorage` backup saved when import completes (`import-log-storage.ts`) so warnings show even if API DB field is empty; hint when only browser copy exists.

