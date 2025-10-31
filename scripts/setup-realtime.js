#!/usr/bin/env node

const { neon } = require('@neondatabase/serverless')
require('dotenv').config()

const sql = neon(process.env.DATABASE_URL)

async function setupRealtimeTriggers() {
  try {
    console.log('🔧 Setting up PostgreSQL realtime triggers...')

    // Create the trigger function
    await sql.unsafe(`
      -- Function to send NOTIFY events for table changes
      CREATE OR REPLACE FUNCTION notify_table_change()
      RETURNS TRIGGER AS $$
      DECLARE
        channel_name TEXT;
        payload JSONB;
      BEGIN
        -- Create channel name: table_changes:public:table_name
        channel_name := 'table_changes:' || TG_TABLE_SCHEMA || ':' || TG_TABLE_NAME;
        
        -- Build payload based on operation type
        IF TG_OP = 'INSERT' THEN
          payload := jsonb_build_object(
            'type', 'INSERT',
            'schema', TG_TABLE_SCHEMA,
            'table', TG_TABLE_NAME,
            'new_record', row_to_json(NEW),
            'timestamp', extract(epoch from now())::bigint
          );
        ELSIF TG_OP = 'UPDATE' THEN
          payload := jsonb_build_object(
            'type', 'UPDATE',
            'schema', TG_TABLE_SCHEMA,
            'table', TG_TABLE_NAME,
            'old_record', row_to_json(OLD),
            'new_record', row_to_json(NEW),
            'timestamp', extract(epoch from now())::bigint
          );
        ELSIF TG_OP = 'DELETE' THEN
          payload := jsonb_build_object(
            'type', 'DELETE',
            'schema', TG_TABLE_SCHEMA,
            'table', TG_TABLE_NAME,
            'old_record', row_to_json(OLD),
            'timestamp', extract(epoch from now())::bigint
          );
        END IF;
        
        -- Send NOTIFY event
        PERFORM pg_notify(channel_name, payload::text);
        
        -- Return appropriate record
        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        ELSE
          RETURN NEW;
        END IF;
      END;
      $$ LANGUAGE plpgsql;
    `)

    console.log('✅ Created notify_table_change() function')

    // Create helper functions
    await sql.unsafe(`
      -- Helper function to enable real-time for a specific table
      CREATE OR REPLACE FUNCTION enable_realtime_for_table(
        schema_name TEXT,
        table_name TEXT
      ) RETURNS VOID AS $$
      DECLARE
        trigger_name TEXT;
      BEGIN
        trigger_name := 'realtime_trigger_' || schema_name || '_' || table_name;
        
        -- Drop existing trigger if it exists
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', 
          trigger_name, schema_name, table_name);
        
        -- Create new trigger
        EXECUTE format(
          'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION notify_table_change()',
          trigger_name, schema_name, table_name
        );
        
        RAISE NOTICE 'Realtime enabled for %.%', schema_name, table_name;
      END;
      $$ LANGUAGE plpgsql;

      -- Helper function to disable real-time for a specific table
      CREATE OR REPLACE FUNCTION disable_realtime_for_table(
        schema_name TEXT,
        table_name TEXT
      ) RETURNS VOID AS $$
      DECLARE
        trigger_name TEXT;
      BEGIN
        trigger_name := 'realtime_trigger_' || schema_name || '_' || table_name;
        
        EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I.%I', 
          trigger_name, schema_name, table_name);
        
        RAISE NOTICE 'Realtime disabled for %.%', schema_name, table_name;
      END;
      $$ LANGUAGE plpgsql;
    `)

    console.log('✅ Created helper functions')

    // Grant permissions
    await sql.unsafe(`
      GRANT EXECUTE ON FUNCTION notify_table_change() TO PUBLIC;
      GRANT EXECUTE ON FUNCTION enable_realtime_for_table(TEXT, TEXT) TO PUBLIC;
      GRANT EXECUTE ON FUNCTION disable_realtime_for_table(TEXT, TEXT) TO PUBLIC;
    `)

    console.log('✅ Granted permissions')

    // Enable realtime for common tables
    const tables = ['notes', 'users', 'api_keys', 'webhooks']
    
    for (const table of tables) {
      try {
        await sql.unsafe(`SELECT enable_realtime_for_table('public', '${table}')`)
        console.log(`✅ Enabled realtime for public.${table}`)
      } catch (error) {
        console.log(`⚠️  Could not enable realtime for public.${table} (table may not exist)`)
      }
    }

    console.log('🎉 Realtime triggers setup completed!')
    console.log('\n📡 Real-time notifications are now enabled for:')
    console.log('   - Channel format: table_changes:public:table_name')
    console.log('   - Supported operations: INSERT, UPDATE, DELETE')
    console.log('   - Payload includes: type, schema, table, records, timestamp')
    
  } catch (error) {
    console.error('❌ Error setting up realtime triggers:', error)
    process.exit(1)
  }
}

if (require.main === module) {
  setupRealtimeTriggers()
}

module.exports = { setupRealtimeTriggers }