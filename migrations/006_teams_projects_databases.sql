-- Migration: Add Teams, Projects, and Databases hierarchy
-- This migration restructures the data model to support:
-- User -> Teams (organizations) -> Projects -> Databases

-- Add databases table (databases belong to projects)
CREATE TABLE IF NOT EXISTS databases (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  database_url TEXT NOT NULL,
  provider VARCHAR(50) DEFAULT 'postgres' CHECK (provider IN ('postgres', 'neon', 'supabase')),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'maintenance')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, name)
);

-- Update projects table - remove database_url since databases now have it
-- Keep it for backward compatibility but it will be deprecated
ALTER TABLE projects ADD COLUMN IF NOT EXISTS description TEXT;

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_databases_project_id ON databases(project_id);
CREATE INDEX IF NOT EXISTS idx_databases_status ON databases(status);
CREATE INDEX IF NOT EXISTS idx_projects_org_id ON projects(org_id);

-- Update trigger for databases updated_at
CREATE TRIGGER update_databases_updated_at 
  BEFORE UPDATE ON databases 
  FOR EACH ROW 
  EXECUTE FUNCTION update_updated_at_column();

