-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "role_prefix" VARCHAR(20);

-- CreateIndex
CREATE UNIQUE INDEX "projects_role_prefix_key" ON "projects"("role_prefix");

