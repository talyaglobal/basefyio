#!/usr/bin/env node

/**
 * Generate secure random secrets for environment variables
 * Run with: node scripts/generate-env-secrets.js
 */

const crypto = require('crypto')

function generateSecret(length = 64) {
  return crypto.randomBytes(length).toString('hex')
}

function generateBase64Secret(length = 64) {
  return crypto.randomBytes(length).toString('base64')
}

console.log('🔐 Generated Secure Secrets for Environment Variables')
console.log('=' .repeat(60))
console.log()
console.log('Copy these values to your .env file:')
console.log()

console.log(`# Authentication Secrets`)
console.log(`JWT_SECRET=${generateSecret(32)}`)
console.log(`REFRESH_SECRET=${generateSecret(32)}`)
console.log(`MAGIC_SECRET=${generateSecret(32)}`)
console.log()

console.log(`# Master Encryption Key (VERY IMPORTANT - Store securely!)`)
console.log(`KOLAYBASE_MASTER_KEY=${generateBase64Secret(32)}`)
console.log()

console.log(`# Storage Secret`)
console.log(`STORAGE_SECRET=${generateSecret(32)}`)
console.log()

console.log('🔒 SECURITY NOTES:')
console.log('=' .repeat(60))
console.log('• Store these secrets securely - they protect your application')
console.log('• Never share or commit these secrets to version control')
console.log('• Use different secrets for development, staging, and production')
console.log('• The KOLAYBASE_MASTER_KEY is used for encrypting stored secrets')
console.log('• If you lose the KOLAYBASE_MASTER_KEY, encrypted data cannot be recovered')
console.log()
console.log('💡 TIP: Save a backup of your production KOLAYBASE_MASTER_KEY in a secure location!')