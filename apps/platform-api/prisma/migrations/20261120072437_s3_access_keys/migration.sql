-- CreateTable
CREATE TABLE "project_s3_keys" (
    "id" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access_key_id" TEXT NOT NULL,
    "secret_last4" TEXT NOT NULL,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by" TEXT,

    CONSTRAINT "project_s3_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_bucket_owners" (
    "physical_name" TEXT NOT NULL,
    "project_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "storage_bucket_owners_pkey" PRIMARY KEY ("physical_name")
);

-- CreateIndex
CREATE UNIQUE INDEX "project_s3_keys_access_key_id_key" ON "project_s3_keys"("access_key_id");

-- CreateIndex
CREATE INDEX "project_s3_keys_project_id_idx" ON "project_s3_keys"("project_id");

-- CreateIndex
CREATE INDEX "storage_bucket_owners_project_id_idx" ON "storage_bucket_owners"("project_id");
