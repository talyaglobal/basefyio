-- Phase 10d: add PARTIAL_FAILED to ProvisioningOperationStatus
-- Some actions succeeded, some failed — partial resource mutations may have occurred.
-- IF NOT EXISTS prevents errors if the migration is applied more than once.
ALTER TYPE "ProvisioningOperationStatus" ADD VALUE IF NOT EXISTS 'PARTIAL_FAILED';
