-- Vector setup of a Data Engine entity ({ mode, dimensions }). Null = the entity stores no vectors.
ALTER TABLE "entity_definitions" ADD COLUMN "vector_config" JSONB;
