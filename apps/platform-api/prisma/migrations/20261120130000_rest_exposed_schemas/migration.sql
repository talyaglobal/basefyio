-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "rest_exposed_schemas" TEXT[] DEFAULT ARRAY[]::TEXT[];
