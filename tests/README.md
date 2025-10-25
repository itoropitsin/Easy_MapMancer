# Tests

This directory contains all tests for the Easy MapMancer project.

## Structure

```
tests/
├── README.md                 # This file
├── integration/              # Integration tests
│   └── user-database.test.js # User database creation and management tests
└── unit/                     # Unit tests (to be added)
```

## Running Tests

### Integration Tests

Integration tests verify that different parts of the system work together correctly.

```bash
# Run user database tests
node tests/integration/user-database.test.js
```

### Unit Tests

Unit tests (to be implemented) will test individual components in isolation.

## Test Categories

### Integration Tests
- **user-database.test.js**: Tests user database creation, first user setup, and authentication flow

### Unit Tests (Planned)
- UserManager class methods
- Authentication functions
- WebSocket message handling
- Map rendering functions

## Adding New Tests

When adding new tests:

1. **Integration tests** go in `tests/integration/`
2. **Unit tests** go in `tests/unit/`
3. Use descriptive filenames ending with `.test.js`
4. Include a brief description in this README
5. Make tests executable with `chmod +x filename`

## Test Requirements

- Tests should be self-contained and not depend on external services
- Clean up after themselves (remove test data)
- Provide clear success/failure messages
- Exit with code 0 on success, non-zero on failure
