# DnD Map Maker

A modern web application for creating and managing interactive maps for tabletop role-playing games with real-time multiplayer support.

## Features

- 🎮 **Real-time Multiplayer**: WebSocket-based synchronization
- 🗺️ **Interactive Maps**: Create and edit maps with 100+ assets
- 👥 **Character Management**: Tokens with stats, vision, and notes
- 🌫️ **Fog of War**: Automatic and manual visibility control
- 🎨 **Map Editor**: Brush tools, floor painting, asset placement
- 💾 **Save/Load**: JSON-based map persistence
- ↩️ **Undo/Redo**: Complete action history system
- 🎭 **Role System**: DM and Player roles with different permissions

## Tech Stack

- **Frontend**: TypeScript + PixiJS v8 + Vite
- **Backend**: Node.js + WebSocket
- **Architecture**: Monorepo with npm workspaces
- **Graphics**: PixiJS for 2D rendering

## Quick Start

```bash
git clone https://github.com/yourusername/dnd-map-maker.git
cd dnd-map-maker
npm install
npm run dev
```

Open http://localhost:5173/?inv=dm-local for DM mode or http://localhost:5173/?inv=pl-local for Player mode.

## License

MIT License - see [LICENSE](LICENSE) file for details.
