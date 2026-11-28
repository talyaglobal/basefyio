-- Marker for projects whose app still connects to the pooler without TLS. Null = no notice.
ALTER TABLE "projects" ADD COLUMN "db_tls_notice_at" TIMESTAMPTZ;
