-- Progress of a Data Engine entity's platform re-embed. Null = no run yet. Additive, no data change.
ALTER TABLE "entity_definitions" ADD COLUMN "vector_reembed_state" JSONB;
