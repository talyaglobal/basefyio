#!/usr/bin/env node

// Database setup script for Kolaybase
// This script initializes the PostgreSQL database with all required tables

require('dotenv').config();
const fs = require('fs');
const path = require('path');

async function setupDatabase() {
  console.log('🚀 Setting up Kolaybase database...');

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

    // Read and execute the init SQL scripts
    const initSqlPath = path.join(__dirname, 'init-db.sql');
    const realtimeSqlPath = path.join(__dirname, 'realtime-schema.sql');
    const quotaSchedulingSqlPath = path.join(__dirname, 'quota-and-scheduling-schema.sql');
    
    console.log('📋 Executing database initialization scripts...');
    
    // Combine all SQL files
    const initSql = fs.readFileSync(initSqlPath, 'utf8');
    const realtimeSql = fs.readFileSync(realtimeSqlPath, 'utf8');
    const quotaSchedulingSql = fs.readFileSync(quotaSchedulingSqlPath, 'utf8');
    const combinedSql = initSql + '\n\n' + realtimeSql + '\n\n' + quotaSchedulingSql;
    
    // Split the SQL file into individual statements
    const statements = combinedSql
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0);

    let successCount = 0;
    let errorCount = 0;

    for (const statement of statements) {
      try {
        await sql.unsafe(statement);
        successCount++;
      } catch (error) {
        console.error(`❌ Error executing statement: ${statement.substring(0, 50)}...`);
        console.error(`   Error: ${error.message}`);
        errorCount++;
      }
    }

    console.log(`\n✅ Database setup completed!`);
    console.log(`   Successful statements: ${successCount}`);
    console.log(`   Failed statements: ${errorCount}`);

    if (errorCount === 0) {
      console.log('\n🎉 All tables and indexes created successfully!');
      console.log('📝 Default admin user created: admin@kolaybase.com (change password in production)');
      console.log('🗂️  Default storage buckets created: avatars, uploads, public');
      console.log('🔄 Realtime functionality enabled');
      console.log('⚡ Edge functions system ready');
      console.log('📅 Scheduled jobs system initialized');
      console.log('🔐 Secrets manager configured');
      console.log('📊 Quota monitoring system ready');
      console.log('⚙️  System configuration defaults set');
      console.log('🔑 Default encryption keys configured (update in production!)');
    } else {
      console.log('\n⚠️  Some errors occurred during setup. Please check the logs above.');
    }

    // Test the database connection by running a simple query
    console.log('\n🔍 Testing database connection...');
    const result = await sql`SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = 'public'`;
    console.log(`✅ Found ${result[0].table_count} tables in the public schema`);

  } catch (error) {
    console.error('❌ Database setup failed:');
    console.error(error.message);
    process.exit(1);
  }
}

// Run the setup
setupDatabase();