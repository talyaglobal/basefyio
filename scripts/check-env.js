#!/usr/bin/env node

/**
 * Validate environment variables for Kolaybase
 * Run with: node scripts/check-env.js
 */

require('dotenv').config()

const requiredVars = [
  'DATABASE_URL',
  'JWT_SECRET'
]

const recommendedVars = [
  'KOLAYBASE_MASTER_KEY',
  'REFRESH_SECRET',
  'MAGIC_SECRET'
]

const productionVars = [
  'NEXT_PUBLIC_BASE_URL',
  'NEXT_PUBLIC_API_URL'
]

function checkVariables() {
  console.log('🔍 Environment Variables Check')
  console.log('=' .repeat(50))
  console.log()

  let hasErrors = false
  let hasWarnings = false

  // Check required variables
  console.log('📋 Required Variables:')
  requiredVars.forEach(varName => {
    const value = process.env[varName]
    if (!value) {
      console.log(`❌ ${varName}: Missing (Required)`)
      hasErrors = true
    } else if (value.includes('your_') || value.includes('change_me')) {
      console.log(`⚠️  ${varName}: Set but contains placeholder text`)
      hasWarnings = true
    } else {
      console.log(`✅ ${varName}: OK`)
    }
  })

  console.log()

  // Check recommended variables
  console.log('💡 Recommended Variables:')
  recommendedVars.forEach(varName => {
    const value = process.env[varName]
    if (!value) {
      console.log(`⚠️  ${varName}: Missing (Recommended)`)
      hasWarnings = true
    } else if (value.includes('your_') || value.includes('change_me')) {
      console.log(`⚠️  ${varName}: Set but contains placeholder text`)
      hasWarnings = true
    } else {
      console.log(`✅ ${varName}: OK`)
    }
  })

  console.log()

  // Check production variables if in production
  if (process.env.NODE_ENV === 'production') {
    console.log('🚀 Production Variables:')
    productionVars.forEach(varName => {
      const value = process.env[varName]
      if (!value) {
        console.log(`❌ ${varName}: Missing (Required for production)`)
        hasErrors = true
      } else if (value.includes('localhost')) {
        console.log(`⚠️  ${varName}: Contains localhost (may not be suitable for production)`)
        hasWarnings = true
      } else {
        console.log(`✅ ${varName}: OK`)
      }
    })
    console.log()
  }

  // Database URL validation
  if (process.env.DATABASE_URL) {
    const dbUrl = process.env.DATABASE_URL
    console.log('🗄️  Database Configuration:')
    
    if (dbUrl.includes('your_') || dbUrl.includes('change_me')) {
      console.log(`❌ DATABASE_URL: Contains placeholder text`)
      hasErrors = true
    } else if (!dbUrl.startsWith('postgresql://')) {
      console.log(`⚠️  DATABASE_URL: Not a PostgreSQL connection string`)
      hasWarnings = true
    } else {
      console.log(`✅ DATABASE_URL: Valid PostgreSQL connection string`)
    }
    console.log()
  }

  // JWT Secret strength check
  if (process.env.JWT_SECRET) {
    const jwtSecret = process.env.JWT_SECRET
    console.log('🔐 Security Check:')
    
    if (jwtSecret.length < 32) {
      console.log(`⚠️  JWT_SECRET: Short length (${jwtSecret.length} chars). Recommend 64+ characters.`)
      hasWarnings = true
    } else if (jwtSecret.includes('your_') || jwtSecret === 'your-secret-key') {
      console.log(`❌ JWT_SECRET: Using default/placeholder value`)
      hasErrors = true
    } else {
      console.log(`✅ JWT_SECRET: Good length (${jwtSecret.length} characters)`)
    }
    console.log()
  }

  // Summary
  console.log('📊 Summary:')
  console.log('=' .repeat(50))
  if (hasErrors) {
    console.log('❌ Environment has ERRORS - Application may not start')
    console.log('   Fix the missing required variables above')
  } else if (hasWarnings) {
    console.log('⚠️  Environment has WARNINGS - Application will start but may not be secure')
    console.log('   Consider fixing the warnings above')
  } else {
    console.log('✅ Environment configuration looks good!')
  }

  console.log()
  console.log('💡 Tips:')
  console.log('• Run "node scripts/generate-env-secrets.js" to generate secure secrets')
  console.log('• Copy .env.example to .env for a complete template')
  console.log('• Never commit .env files to version control')
  console.log()

  // Exit with error code if there are critical errors
  if (hasErrors) {
    process.exit(1)
  }
}

// Run the check
checkVariables()