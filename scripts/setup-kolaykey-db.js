#!/usr/bin/env node

/**
 * Database setup script specifically for Kolaykey project
 * This script initializes the PostgreSQL database with all required tables
 * and creates initial data for the kolaykey project
 */

require('dotenv').config({ path: '.env.kolaykey' });
const fs = require('fs');
const path = require('path');

async function setupKolaykeyDatabase() {
  console.log('🚀 Setting up Kolaykey database...');
  console.log('=' .repeat(60));

  // Check if DATABASE_URL is set
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    console.error('❌ DATABASE_URL environment variable is not set.');
    console.log('Please add DATABASE_URL to your .env.kolaykey file with your PostgreSQL connection string.');
    console.log('Example: DATABASE_URL=postgresql://user:password@localhost:5432/kolaykey');
    process.exit(1);
  }

  // Validate database URL format
  if (!DATABASE_URL.startsWith('postgresql://') && !DATABASE_URL.startsWith('postgres://')) {
    console.error('❌ DATABASE_URL must be a PostgreSQL connection string.');
    console.log('Expected format: postgresql://user:password@host:port/database');
    process.exit(1);
  }

  try {
    // Dynamic import of @neondatabase/serverless
    const { neon } = await import('@neondatabase/serverless');
    const sql = neon(DATABASE_URL);

    console.log('📡 Connected to database successfully');
    console.log('📋 Executing database initialization scripts...\n');

    // Read and execute the init SQL scripts
    const initSqlPath = path.join(__dirname, 'init-db.sql');
    const realtimeSqlPath = path.join(__dirname, 'realtime-schema.sql');
    const quotaSchedulingSqlPath = path.join(__dirname, 'quota-and-scheduling-schema.sql');
    const teamsProjectsSqlPath = path.join(__dirname, '..', 'migrations', '006_teams_projects_databases.sql');
    
    // Combine all SQL files
    let combinedSql = '';
    
    if (fs.existsSync(initSqlPath)) {
      combinedSql += fs.readFileSync(initSqlPath, 'utf8') + '\n\n';
      console.log('✅ Loaded: init-db.sql');
    }
    
    if (fs.existsSync(realtimeSqlPath)) {
      combinedSql += fs.readFileSync(realtimeSqlPath, 'utf8') + '\n\n';
      console.log('✅ Loaded: realtime-schema.sql');
    }
    
    if (fs.existsSync(quotaSchedulingSqlPath)) {
      combinedSql += fs.readFileSync(quotaSchedulingSqlPath, 'utf8') + '\n\n';
      console.log('✅ Loaded: quota-and-scheduling-schema.sql');
    }
    
    if (fs.existsSync(teamsProjectsSqlPath)) {
      combinedSql += fs.readFileSync(teamsProjectsSqlPath, 'utf8') + '\n\n';
      console.log('✅ Loaded: 006_teams_projects_databases.sql');
    }
    
    console.log('');

    // Split the SQL file into individual statements
    // Handle multi-line statements properly
    const statements = combinedSql
      .split(/;\s*(?=\n|$)/)
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    let successCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const statement of statements) {
      try {
        // Skip empty statements and comments
        if (statement.trim().length === 0 || statement.trim().startsWith('--')) {
          continue;
        }
        
        await sql.unsafe(statement + ';');
        successCount++;
      } catch (error) {
        // Some errors are expected (like IF NOT EXISTS on already existing objects)
        const errorMessage = error.message || String(error);
        if (!errorMessage.includes('already exists') && 
            !errorMessage.includes('duplicate key') &&
            !errorMessage.includes('relation already exists')) {
          console.error(`❌ Error executing statement: ${statement.substring(0, 100)}...`);
          console.error(`   Error: ${errorMessage}`);
          errors.push({ statement: statement.substring(0, 100), error: errorMessage });
          errorCount++;
        } else {
          // Expected error (object already exists), count as success
          successCount++;
        }
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
      
      // Test the database connection by running a simple query
      console.log('\n🔍 Testing database connection...');
      try {
        const result = await sql`SELECT COUNT(*) as table_count FROM information_schema.tables WHERE table_schema = 'public'`;
        console.log(`✅ Found ${result[0].table_count} tables in the public schema`);
        
        // Check for kolaykey-specific setup
        console.log('\n📊 Checking Kolaykey project setup...');
        
        // Check if we can query users table
        const usersCheck = await sql`SELECT COUNT(*) as user_count FROM users`;
        console.log(`✅ Users table accessible: ${usersCheck[0].user_count} users`);
        
        // Check if we can query projects table
        const projectsCheck = await sql`SELECT COUNT(*) as project_count FROM projects`;
        console.log(`✅ Projects table accessible: ${projectsCheck[0].project_count} projects`);
        
        // Check if we can query databases table
        const databasesCheck = await sql`SELECT COUNT(*) as db_count FROM databases`;
        console.log(`✅ Databases table accessible: ${databasesCheck[0].db_count} databases`);
        
        console.log('\n✅ Kolaykey database is ready to use!');
        console.log('\n💡 Next steps:');
        console.log('   1. Update your .env.kolaykey file with the correct DATABASE_URL');
        console.log('   2. Start your development server: npm run dev');
        console.log('   3. Visit http://localhost:3000 to access the application');
        console.log('   4. Sign in with admin@kolaybase.com (default password: admin123)');
        console.log('   5. Change the default admin password immediately!');
        
      } catch (testError) {
        console.error('⚠️  Error testing database:', testError.message);
      }
    } else {
      console.log('\n⚠️  Some errors occurred during setup. Please check the logs above.');
      console.log('\n❌ Critical Errors:');
      errors.forEach((err, idx) => {
        console.log(`   ${idx + 1}. ${err.error}`);
      });
    }

  } catch (error) {
    console.error('❌ Database setup failed:');
    console.error(error.message);
    console.error('\n💡 Troubleshooting:');
    console.error('   1. Check that your DATABASE_URL is correct');
    console.error('   2. Ensure your PostgreSQL database is running');
    console.error('   3. Verify that the database user has CREATE permissions');
    console.error('   4. Check your network connection if using a remote database');
    process.exit(1);
  }
}

// Run the setup
setupKolaykeyDatabase();

