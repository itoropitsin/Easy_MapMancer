#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const USERS_DB_PATH = path.join(__dirname, 'packages/server/data/users.json');

console.log('🔍 Debug test for user database creation...');
console.log('USERS_DB_PATH:', USERS_DB_PATH);
console.log('File exists before import:', fs.existsSync(USERS_DB_PATH));

// Remove existing database
if (fs.existsSync(USERS_DB_PATH)) {
  fs.unlinkSync(USERS_DB_PATH);
  console.log('✅ Removed existing users.json');
}

console.log('File exists after removal:', fs.existsSync(USERS_DB_PATH));

// Import UserManager
import('./packages/server/dist/user-manager.js').then(({ UserManager }) => {
  console.log('✅ UserManager imported successfully');
  
  const userManager = new UserManager();
  console.log('✅ UserManager instance created');
  
  console.log('File exists after UserManager creation:', fs.existsSync(USERS_DB_PATH));
  
  if (fs.existsSync(USERS_DB_PATH)) {
    const data = fs.readFileSync(USERS_DB_PATH, 'utf8');
    console.log('Database content:', data);
  }
  
  console.log('needsFirstUser():', userManager.needsFirstUser());
}).catch(error => {
  console.log('❌ Error:', error);
});
