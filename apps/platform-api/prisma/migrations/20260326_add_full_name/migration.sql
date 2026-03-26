-- Replace full_name with separate first_name and last_name columns
ALTER TABLE users DROP COLUMN IF EXISTS full_name;
ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name TEXT;
