#!/usr/bin/env node

// Example unit test for Easy MapMancer
// This is a placeholder to demonstrate the unit test structure

console.log('🧪 Example Unit Test');
console.log('===================');

// Example test function
function add(a, b) {
  return a + b;
}

// Test cases
const testCases = [
  { input: [2, 3], expected: 5, description: '2 + 3 = 5' },
  { input: [0, 0], expected: 0, description: '0 + 0 = 0' },
  { input: [-1, 1], expected: 0, description: '-1 + 1 = 0' },
  { input: [10, -5], expected: 5, description: '10 + (-5) = 5' }
];

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = add(...testCase.input);
  if (result === testCase.expected) {
    console.log(`✅ ${testCase.description}`);
    passed++;
  } else {
    console.log(`❌ ${testCase.description} - Expected ${testCase.expected}, got ${result}`);
    failed++;
  }
}

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log('🎉 All unit tests passed!');
  process.exit(0);
} else {
  console.log('💥 Some unit tests failed!');
  process.exit(1);
}
