-- Add ADMIN role to TeamMemberRole enum.
-- ADMIN members can manage integrations alongside OWNER.

ALTER TYPE "TeamMemberRole" ADD VALUE 'ADMIN' BEFORE 'MEMBER';
