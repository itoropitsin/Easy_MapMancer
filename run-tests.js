#!/usr/bin/env node

// Test runner for Easy MapMancer
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🧪 Running Easy MapMancer Tests\n');

const testsDir = path.join(__dirname, 'tests');
const integrationDir = path.join(testsDir, 'integration');
const unitDir = path.join(testsDir, 'unit');

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

// Run integration tests
console.log('📋 Integration Tests');
console.log('==================');

if (fs.existsSync(integrationDir)) {
  const integrationTests = fs.readdirSync(integrationDir)
    .filter(file => file.endsWith('.test.js'))
    .sort();

  for (const testFile of integrationTests) {
    const testPath = path.join(integrationDir, testFile);
    totalTests++;
    
    console.log(`\n▶️  Running ${testFile}...`);
    
    try {
      execSync(`node "${testPath}"`, { 
        stdio: 'inherit',
        cwd: __dirname 
      });
      console.log(`✅ ${testFile} passed`);
      passedTests++;
    } catch (error) {
      console.log(`❌ ${testFile} failed`);
      failedTests++;
    }
  }
} else {
  console.log('No integration tests found');
}

// Run unit tests
console.log('\n📋 Unit Tests');
console.log('=============');

if (fs.existsSync(unitDir)) {
  const unitTests = fs.readdirSync(unitDir)
    .filter(file => file.endsWith('.test.js'))
    .sort();

  for (const testFile of unitTests) {
    const testPath = path.join(unitDir, testFile);
    totalTests++;
    
    console.log(`\n▶️  Running ${testFile}...`);
    
    try {
      execSync(`node "${testPath}"`, { 
        stdio: 'inherit',
        cwd: __dirname 
      });
      console.log(`✅ ${testFile} passed`);
      passedTests++;
    } catch (error) {
      console.log(`❌ ${testFile} failed`);
      failedTests++;
    }
  }
} else {
  console.log('No unit tests found');
}

// Summary
console.log('\n📊 Test Summary');
console.log('================');
console.log(`Total tests: ${totalTests}`);
console.log(`Passed: ${passedTests}`);
console.log(`Failed: ${failedTests}`);

if (failedTests === 0) {
  console.log('\n🎉 All tests passed!');
  process.exit(0);
} else {
  console.log(`\n💥 ${failedTests} test(s) failed!`);
  process.exit(1);
}
