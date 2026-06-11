-- Add CANCELLED to ProvisioningOperationStatus enum
-- Only PENDING operations can be cancelled (enforced at application layer).
ALTER TYPE "ProvisioningOperationStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
