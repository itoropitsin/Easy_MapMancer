#!/usr/bin/env node

// Test script to verify user database creation
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const USERS_DB_PATH = path.join(__dirname, '../../packages/server/data/users.json');

console.log('🧪 Testing user database creation...');

// Remove existing database
if (fs.existsSync(USERS_DB_PATH)) {
  fs.unlinkSync(USERS_DB_PATH);
  console.log('✅ Removed existing users.json');
}

// Test 1: Check that database doesn't exist
if (!fs.existsSync(USERS_DB_PATH)) {
  console.log('✅ Database file does not exist initially');
} else {
  console.log('❌ Database file exists when it shouldn\'t');
  process.exit(1);
}

// Test 2: Import UserManager and check needsFirstUser
import('../../packages/server/dist/user-manager.js').then(({ UserManager }) => {
  const userManager = new UserManager();
  
  // Test 3: Check that database was created
  if (fs.existsSync(USERS_DB_PATH)) {
    console.log('✅ Database file was created automatically');
    
    const data = fs.readFileSync(USERS_DB_PATH, 'utf8');
    const users = JSON.parse(data);
    
    if (Array.isArray(users) && users.length === 0) {
      console.log('✅ Database contains empty array as expected');
    } else {
      console.log('❌ Database should contain empty array');
      process.exit(1);
    }
  } else {
    console.log('❌ Database file was not created');
    process.exit(1);
  }
  
  runRemainingTests(userManager);
}).catch(error => {
  console.log('❌ Error importing UserManager:', error);
  process.exit(1);
});

function runRemainingTests(userManager) {
  // Test 4: Check that needsFirstUser returns true
  if (userManager.needsFirstUser()) {
    console.log('✅ needsFirstUser() returns true for empty database');
  } else {
    console.log('❌ needsFirstUser() should return true for empty database');
    process.exit(1);
  }
  
  // Test 5: Test creating first user
  userManager.createFirstUser({
    username: 'testuser',
    email: 'test@example.com'
  }).then(result => {
    if (result.success && result.user && result.generatedPassword) {
      console.log('✅ First user created successfully');
      console.log('   Username:', result.user.username);
      console.log('   Email:', result.user.email);
      console.log('   Role:', result.user.role);
      console.log('   Password length:', result.generatedPassword.length);
      
      // Test 6: Check that needsFirstUser now returns false
      if (!userManager.needsFirstUser()) {
        console.log('✅ needsFirstUser() returns false after creating user');
      } else {
        console.log('❌ needsFirstUser() should return false after creating user');
        process.exit(1);
      }
      
      console.log('🎉 All tests passed! User database system is working correctly.');
    } else {
      console.log('❌ Failed to create first user:', result.error);
      process.exit(1);
    }
  }).catch(error => {
    console.log('❌ Error creating first user:', error);
    process.exit(1);
  });
}
