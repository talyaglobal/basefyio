-- CreateTable: project_folders
CREATE TABLE IF NOT EXISTS "project_folders" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6366f1',
    "team_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_folders_pkey" PRIMARY KEY ("id")
);

-- CreateTable: project_tags
CREATE TABLE IF NOT EXISTS "project_tags" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#8b5cf6',
    "team_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable: project_tag_assignments
CREATE TABLE IF NOT EXISTS "project_tag_assignments" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "tag_id" TEXT NOT NULL,
    CONSTRAINT "project_tag_assignments_pkey" PRIMARY KEY ("id")
);

-- Add folder_id to projects
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "folder_id" TEXT;

-- AddForeignKey: project_folders -> teams
ALTER TABLE "project_folders" ADD CONSTRAINT "project_folders_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: project_tags -> teams
ALTER TABLE "project_tags" ADD CONSTRAINT "project_tags_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: project_tag_assignments -> projects
ALTER TABLE "project_tag_assignments" ADD CONSTRAINT "project_tag_assignments_project_id_fkey"
    FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: project_tag_assignments -> project_tags
ALTER TABLE "project_tag_assignments" ADD CONSTRAINT "project_tag_assignments_tag_id_fkey"
    FOREIGN KEY ("tag_id") REFERENCES "project_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: projects -> project_folders (nullable, SetNull on delete)
ALTER TABLE "projects" ADD CONSTRAINT "projects_folder_id_fkey"
    FOREIGN KEY ("folder_id") REFERENCES "project_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- UniqueIndex: project_tags (team_id, name)
CREATE UNIQUE INDEX IF NOT EXISTS "project_tags_team_id_name_key" ON "project_tags"("team_id", "name");

-- UniqueIndex: project_tag_assignments (project_id, tag_id)
CREATE UNIQUE INDEX IF NOT EXISTS "project_tag_assignments_project_id_tag_id_key" ON "project_tag_assignments"("project_id", "tag_id");
