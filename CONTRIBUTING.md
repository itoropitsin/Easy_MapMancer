# Contributing to DnD Map Maker

Thank you for your interest in contributing to DnD Map Maker! This document provides guidelines and information for contributors.

## 🤝 How to Contribute

### Reporting Bugs

Before creating a bug report, please check if the issue has already been reported in the [Issues](https://github.com/yourusername/dnd-map-maker/issues) section.

When creating a bug report, please include:

- **Clear description** of the bug
- **Steps to reproduce** the issue
- **Expected behavior** vs actual behavior
- **Screenshots** if applicable
- **Environment details** (browser, OS, Node.js version)
- **Console errors** if any

### Suggesting Features

We welcome feature suggestions! Please:

- Check existing [Discussions](https://github.com/yourusername/dnd-map-maker/discussions) first
- Provide a clear description of the feature
- Explain the use case and benefits
- Consider implementation complexity

### Pull Requests

1. **Fork the repository**
2. **Create a feature branch**: `git checkout -b feature/amazing-feature`
3. **Make your changes**
4. **Test your changes** thoroughly
5. **Commit your changes**: `git commit -m 'Add amazing feature'`
6. **Push to the branch**: `git push origin feature/amazing-feature`
7. **Open a Pull Request**

## 🛠️ Development Setup

### Prerequisites

- Node.js 18 or higher
- npm 9 or higher
- Git

### Getting Started

1. **Clone your fork**:
```bash
git clone https://github.com/yourusername/dnd-map-maker.git
cd dnd-map-maker
```

2. **Install dependencies**:
```bash
npm install
```

3. **Start development server**:
```bash
npm run dev
```

4. **Open the application**:
- DM: http://localhost:5173/?inv=dm-local
- Player: http://localhost:5173/?inv=pl-local

### Project Structure

```
packages/
├─ client/           # Frontend (TypeScript + PixiJS + Vite)
│  ├─ src/main.ts   # Main client logic
│  └─ index.html    # UI components
├─ server/           # Backend (Node.js + WebSocket)
│  └─ src/index.ts  # Server logic
└─ shared/           # Shared types and protocols
   ├─ types.ts       # Type definitions
   └─ protocol.ts    # WebSocket message schemas
```

## 📝 Coding Standards

### TypeScript

- Use **strict mode** TypeScript
- Avoid `any` type unless absolutely necessary
- Use proper type definitions from `@dnd/shared`
- Follow existing naming conventions

### Code Style

- Use **Prettier** for formatting: `npm run format`
- Use **camelCase** for variables and functions
- Use **PascalCase** for types and classes
- Use **kebab-case** for file names

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` for new features
- `fix:` for bug fixes
- `docs:` for documentation changes
- `style:` for formatting changes
- `refactor:` for code refactoring
- `test:` for adding tests
- `chore:` for maintenance tasks

Examples:
```
feat(client): add fog of war tools
fix(server): resolve token movement validation
docs: update README with new features
```

## 🧪 Testing

### Manual Testing

Manual and automated tests are both used. Please test:

- **Multiplayer functionality** with multiple browser tabs
- **All tools and features** in both DM and Player modes
- **WebSocket connection** stability
- **Undo/redo functionality**
- **Map saving/loading**

### Testing Checklist

- [ ] Feature works in DM mode
- [ ] Feature works in Player mode
- [ ] Multiplayer synchronization works
- [ ] No console errors
- [ ] Performance is acceptable
- [ ] UI is responsive

### Running Tests

```
npm run test
```

- Run specific integration test:

```
node tests/integration/user-database.test.js
```

## 🏗️ Architecture Guidelines

### Client-Server Communication

- All game state changes go through the server
- Use WebSocket messages defined in `packages/shared/src/protocol.ts`
- Validate all client input on the server
- Maintain authoritative server state

### Authentication (since v0.2.0)

- First run requires creating a master user; the client presents a first-user screen.
- Masters can create users, change roles, and reset passwords.
- Users authenticate with username/email and password; sessions can be resumed.

### Adding New Features

1. **Define types** in `packages/shared/src/types.ts`
2. **Add protocol messages** in `packages/shared/src/protocol.ts`
3. **Implement server logic** in `packages/server/src/index.ts`
4. **Add client UI** in `packages/client/index.html`
5. **Implement client logic** in `packages/client/src/main.ts`

### Asset Management

- Add new assets to appropriate categories in `packages/client/src/main.ts`
- Use emoji icons for consistency
- Consider if assets should be interactive (doors, chests)

## 🐛 Debugging

### Client Debugging

- Use browser dev tools
- Check WebSocket messages in Network tab
- Use `console.log` strategically (remove before commit)
- Test with multiple browser tabs

### Server Debugging

- Check server console for errors
- Use `console.log` for debugging
- Test WebSocket connection manually
- Verify file system permissions

## 📋 Pull Request Guidelines

### Before Submitting

- [ ] Code follows project conventions
- [ ] All tests pass (manual testing)
- [ ] Code is formatted with Prettier
- [ ] No console errors
- [ ] Documentation is updated if needed
- [ ] Commit messages follow conventional format

### PR Description

Include:

- **Summary** of changes
- **Motivation** for the change
- **Testing** performed
- **Screenshots** for UI changes
- **Breaking changes** if any

### Review Process

- Maintainers will review your PR
- Address feedback promptly
- Keep PRs focused and small when possible
- Respond to review comments

## 🚀 Release Process

Releases are managed by maintainers:

1. **Version bump** in `package.json`
2. **Changelog update**
3. **Git tag** creation
4. **GitHub release** with notes

## 📞 Getting Help

- **GitHub Issues**: For bugs and feature requests
- **GitHub Discussions**: For questions and general discussion
- **Email**: [Your Email](mailto:your.email@example.com)

## 🎯 Areas for Contribution

### High Priority

- **Testing**: Add automated tests
- **Documentation**: Improve API documentation
- **Performance**: Optimize rendering for large maps
- **Accessibility**: Improve keyboard navigation

### Medium Priority

- **New Assets**: Add more objects and decorations
- **UI Improvements**: Better mobile support
- **Export Features**: PDF export, image export
- **Import Features**: Import from other map formats

### Low Priority

- **Themes**: Dark/light mode
- **Plugins**: Plugin system for extensions
- **Advanced Tools**: More drawing tools
- **Statistics**: Usage analytics

## 📄 License

By contributing to DnD Map Maker, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to DnD Map Maker! 🎲
