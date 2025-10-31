#!/usr/bin/env node

// Add quota monitoring and scheduling tables to existing Kolaybase installation
// Run this script if you already have Kolaybase set up and want to add the new features

require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function addQuotaScheduling() {
  console.log('🚀 Adding quota monitoring and scheduling features to Kolaybase...');

  // Check if DATABASE_URL is set
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is not set.');
    console.log('Please add DATABASE_URL to your .env file with your PostgreSQL connection string.');
    console.log('Example: DATABASE_URL=postgresql://user:password@localhost:5432/kolaybase');
    process.exit(1);
  }

  try {
    // Dynamic import of @neondatabase/serverless
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(DATABASE_URL);

    console.log('📡 Connected to database successfully');

    // Read and execute the quota and scheduling SQL script
    const quotaSchedulingSqlPath = path.join(__dirname, 'quota-and-scheduling-schema.sql');
    
    if (!fs.existsSync(quotaSchedulingSqlPath)) {
      console.error('❌ quota-and-scheduling-schema.sql file not found!');
      console.error('   Expected location:', quotaSchedulingSqlPath);
      process.exit(1);
    }
    
    console.log('📋 Executing quota monitoring and scheduling schema...');
    
    const quotaSchedulingSql = fs.readFileSync(quotaSchedulingSqlPath, 'utf8');
    
    // Split the SQL file into individual statements
    const statements = quotaSchedulingSql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    let successCount = 0;
    let errorCount = 0;

    for (const statement of statements) {
      try {
        await sql.unsafe(statement);
        successCount++;
        // Log important table creations
        if (statement.includes('CREATE TABLE') && statement.includes('quota_')) {
          const tableName = statement.match(/CREATE TABLE[^(]*([a-z_]+)/i)?.[1]?.trim();
          if (tableName) console.log(`  ✅ Created quota table: ${tableName}`);
        }
        if (statement.includes('CREATE TABLE') && statement.includes('scheduled_')) {
          const tableName = statement.match(/CREATE TABLE[^(]*([a-z_]+)/i)?.[1]?.trim();
          if (tableName) console.log(`  ✅ Created scheduling table: ${tableName}`);
        }
      } catch (error) {
        // Ignore "already exists" errors as they're expected for existing installations
        if (error.message.includes('already exists') || error.message.includes('duplicate key')) {
          successCount++; // Count as success since the object already exists
          continue;
        }
        
        console.error(`❌ Error executing statement: ${statement.substring(0, 50)}...`);
        console.error(`   Error: ${error.message}`);
        errorCount++;
      }
    }

    console.log(`\n✅ Schema update completed!`);
    console.log(`   Successful statements: ${successCount}`);
    console.log(`   Failed statements: ${errorCount}`);

    if (errorCount === 0) {
      console.log('\n🎉 Quota monitoring and scheduling features added successfully!');
      console.log('📊 Quota monitoring system ready');
      console.log('📅 Scheduled jobs system initialized');
      console.log('⚡ Edge functions support added');
      console.log('🔐 Secrets management system ready');
      console.log('⚙️  System configuration defaults set');
      console.log('🔑 Default encryption keys configured (update in production!)');
      console.log('\n📖 Next steps:');
      console.log('   1. Review and update encryption keys in production');
      console.log('   2. Configure quota thresholds for your users');
      console.log('   3. Set up alert channels for notifications');
      console.log('   4. Review system configuration values');
    } else {
      console.log('\n⚠️  Some errors occurred during setup. Please check the logs above.');
      console.log('   Note: "already exists" errors are normal for existing installations.');
    }

    // Test the database by checking if new tables exist
    console.log('\n🔍 Verifying new tables...');
    try {
      const result = await sql`
        SELECT table_name 
        FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name IN ('quota_thresholds', 'scheduled_jobs', 'edge_functions', 'secrets')
        ORDER BY table_name
      `;
      
      console.log(`✅ Found ${result.length}/4 expected new tables:`);
      result.forEach(row => console.log(`   - ${row.table_name}`));
      
      if (result.length < 4) {
        console.log('⚠️  Some tables may not have been created. Check the error messages above.');
      }
    } catch (error) {
      console.error('❌ Error verifying tables:', error.message);
    }

  } catch (error) {
    console.error('❌ Schema update failed:');
    console.error(error.message);
    process.exit(1);
  }
}

// Run the update
addQuotaScheduling();