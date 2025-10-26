import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { Server as HTTPServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import type { ServerToClient, ClientToServer, Location, Level, Token, Vec2, Role, ID, Event, Asset, FloorKind, LocationTreeNode, GameSnapshot, FogMode, ActionSnapshot, UndoRedoState, HistoryEvent, HistoryEventDetails, HistoryEventChange } from "@dnd/shared";
import { UserManager } from "./user-manager.js";

const PORT = Number(process.env.PORT || 8080);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve data directory robustly for both dev (tsx) and build (dist):
// 1) LOCATIONS_DIR env
// 2) ../data/locations relative to compiled file
// 3) ../../data/locations (if running from nested dist path)
function resolveDataRoot(): string {
  const fromEnv = process.env.LOCATIONS_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv);
  const candidates = [
    path.resolve(__dirname, "../data/locations"),
    path.resolve(__dirname, "../../data/locations"),
  ];
  for (const p of candidates) {
    try {
      // statSync avoids needing async before first use; will throw if not exists
      const st = statSync(p);
      if (st && st.isDirectory()) return p;
    } catch {}
  }
  // fallback to first candidate
  return candidates[0];
}
const DATA_ROOT = resolveDataRoot();
const LAST_USED_FILE = path.resolve(DATA_ROOT, "last-used.json");

// Simple in-memory state
interface ClientRec {
  id: ID;
  role: Role;
  socket: import("ws").WebSocket;
  user?: any; // User object from authentication
  token?: string; // Session token
}

// Initialize user manager
const userManager = new UserManager();

type ServerActionSnapshot = ActionSnapshot & { historyEvents?: HistoryEvent[] };

function applySnapshot(snap: Partial<GameSnapshot>) {
  const payload = (snap ?? {}) as Partial<GameSnapshot> & Record<string, unknown>;
  const hasProp = (key: PropertyKey): boolean => Object.prototype.hasOwnProperty.call(payload, key);

  const locationProvided = hasProp("location");
  if (locationProvided) {
    const loc = payload.location;
    state.location = (loc && typeof loc === "object" && Array.isArray((loc as any).levels))
      ? deepCopy(loc as Location)
      : makeDefaultLocation();
  }

  if (hasProp("tokens")) {
    state.tokens.clear();
    const tokens = Array.isArray(payload.tokens) ? (payload.tokens as Token[]) : [];
    for (const t of tokens) {
      if (!t || !t.id) continue;
      state.tokens.set(t.id, deepCopy(t));
    }
  }

  if (hasProp("assets")) {
    state.assets.clear();
    const assets = Array.isArray(payload.assets) ? (payload.assets as Asset[]) : [];
    for (const a of assets) {
      if (!a || !a.id) continue;
      state.assets.set(a.id, deepCopy(a));
    }
  }

  const fogLevelsMeta = Array.isArray((payload as any).fogLevels) ? ((payload as any).fogLevels as ID[]) : undefined;
  if (hasProp("events")) {
    const events = Array.isArray(payload.events) ? (payload.events as Event[]) : [];
    if (!fogLevelsMeta) {
      console.log(`[SERVER] applySnapshot: clearing all fog levels (full snapshot)`);
      state.fog.clear();
    } else {
      console.log(`[SERVER] applySnapshot: updating fog for levels: ${fogLevelsMeta.join(", ")}`);
      for (const lvl of fogLevelsMeta) {
        state.fog.set(lvl, new Set());
      }
    }
    for (const e of events) {
      if ((e as any).type === "fogRevealed") {
        const levelId = (e as any).levelId as ID;
        let set = state.fog.get(levelId);
        if (!set) {
          set = new Set<string>();
          state.fog.set(levelId, set);
        }
        const cells = Array.isArray((e as any).cells) ? (e as any).cells as Vec2[] : [];
        console.log(`[SERVER] Restoring fog for level ${levelId}, ${cells.length} cells`);
        for (const c of cells) {
          set.add(cellKey(c));
        }
      }
    }
    if (fogLevelsMeta) {
      for (const lvl of fogLevelsMeta) {
        if (!state.fog.has(lvl)) {
          state.fog.set(lvl, new Set());
        }
      }
    }
    console.log(`[SERVER] applySnapshot: now tracking ${state.fog.size} fog levels`);
  }

  let floorsUpdated = false;
  if (hasProp("floors")) {
    floorsUpdated = true;
    state.floors.clear();
    const floors = Array.isArray(payload.floors)
      ? (payload.floors as { levelId: ID; pos: Vec2; kind: FloorKind }[])
      : [];
    for (const f of floors) {
      if (!f?.levelId || !f.pos) continue;
      let m = state.floors.get(f.levelId);
      if (!m) { m = new Map(); state.floors.set(f.levelId, m); }
      m.set(`${f.pos.x},${f.pos.y}`, f.kind);
    }
  }

  if (locationProvided || floorsUpdated) {
    const addedFloors = ensureDefaultFloorsForAllLevels();
    if (floorsUpdated && addedFloors.length > 0) {
      const existing = new Set(
        Array.isArray(payload.floors)
          ? (payload.floors as { levelId: ID; pos: Vec2; kind: FloorKind }[]).map(
              (f) => `${f.levelId}:${f.pos.x},${f.pos.y}`
            )
          : []
      );
      const merged = Array.isArray(payload.floors)
        ? (payload.floors as { levelId: ID; pos: Vec2; kind: FloorKind }[]).slice()
        : [];
      for (const f of addedFloors) {
        const key = `${f.levelId}:${f.pos.x},${f.pos.y}`;
        if (existing.has(key)) continue;
        existing.add(key);
        merged.push({ levelId: f.levelId, pos: { ...f.pos }, kind: f.kind });
      }
      (payload as any).floors = merged;
    }
  }

  if (hasProp("history")) {
    const history = Array.isArray(payload.history) ? (payload.history as HistoryEvent[]) : [];
    state.history = history.map(ev => deepCopy(ev));
    state.historyByAction.clear();
    for (const ev of state.history) {
      if (!ev.actionId) continue;
      const list = state.historyByAction.get(ev.actionId) ?? [];
      list.push(ev);
      state.historyByAction.set(ev.actionId, list);
    }
  } else if (locationProvided) {
    // Reset history when loading a brand new location snapshot
    state.history = [];
    state.historyByAction.clear();
  }

  if (locationProvided) {
    // Auto-reveal fog for player tokens after loading a full location snapshot
    const isAutomaticMode = !state.location?.fogMode || state.location.fogMode === "automatic";
    if (isAutomaticMode) {
      console.log(`[SERVER] Auto-revealing fog for player tokens in automatic mode`);
      for (const token of state.tokens.values()) {
        const isNPC = (token as any).kind === "npc";
        if (!isNPC) {
          const vr = Math.max(0, Math.min(20, Math.round((token.vision as any)?.radius ?? 0)));
          if (vr > 0) {
            const fog = getFogSet(token.levelId);
            const cells = cellsInRadius(token.pos, vr);
            console.log(`[SERVER] Auto-revealing fog for token ${token.id} at (${token.pos.x}, ${token.pos.y}), ${cells.length} cells`);
            for (const c of cells) {
              const k = cellKey(c);
              if (!fog.has(k)) {
                fog.add(k);
              }
            }
          }
        }
      }
    }
  }
}

// Command pattern for undo/redo instead of full snapshots
interface Command {
  id: string;
  type: string;
  description: string;
  timestamp: number;
  execute(): void;
  undo(): void;
}

interface GameState {
  location: Location;
  tokens: Map<ID, Token>;
  clients: Map<ID, ClientRec>;
  fog: Map<ID, Set<string>>; // levelId -> set of "x,y"
  assets: Map<ID, Asset>;
  floors: Map<ID, Map<string, FloorKind>>; // levelId -> ("x,y" -> kind)
  undoRedo: UndoRedoState;
  commands: Command[]; // New command-based undo/redo
  history: HistoryEvent[];
  historyByAction: Map<string, HistoryEvent[]>;
}

const DEFAULT_FLOOR_KIND: FloorKind = "stone";
const DEFAULT_FLOOR_WIDTH = 10;
const DEFAULT_FLOOR_HEIGHT = 10;

function ensureDefaultFloorsForLevel(levelId: ID): { levelId: ID; pos: Vec2; kind: FloorKind }[] {
  let map = state.floors.get(levelId);
  if (!map) {
    map = new Map();
    state.floors.set(levelId, map);
  }
  const added: { levelId: ID; pos: Vec2; kind: FloorKind }[] = [];
  for (let y = 0; y < DEFAULT_FLOOR_HEIGHT; y++) {
    for (let x = 0; x < DEFAULT_FLOOR_WIDTH; x++) {
      const key = `${x},${y}`;
      if (map.has(key)) continue;
      map.set(key, DEFAULT_FLOOR_KIND);
      added.push({ levelId, pos: { x, y }, kind: DEFAULT_FLOOR_KIND });
    }
  }
  return added;
}

function ensureDefaultFloorsForAllLevels(): { levelId: ID; pos: Vec2; kind: FloorKind }[] {
  const added: { levelId: ID; pos: Vec2; kind: FloorKind }[] = [];
  for (const lvl of state.location.levels) {
    added.push(...ensureDefaultFloorsForLevel(lvl.id));
  }
  return added;
}

function makeDefaultLevel(): Level {
  return {
    id: "L1",
    seed: "seed-1",
    spawnPoint: { x: 5, y: 5 },
    lights: []
  };
}

function makeDefaultLocation(): Location {
  return {
    id: "LOC1",
    name: "Demo Location",
    levels: [makeDefaultLevel()],
    settings: {}
  };
}

function deepCopy<T>(value: T): T {
  if (value === null || value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

const state: GameState = {
  location: makeDefaultLocation(),
  tokens: new Map(),
  clients: new Map(),
  fog: new Map(),
  assets: new Map(),
  floors: new Map(),
  undoRedo: {
    undoStack: [],
    redoStack: [],
    maxStackSize: 50
  },
  commands: [],
  history: [],
  historyByAction: new Map()
};

ensureDefaultFloorsForAllLevels();

// Current file path for autosave (relative to DATA_ROOT)
let currentSavePath: string | null = null;

// Autosave debouncing
let autosaveTimer: NodeJS.Timeout | null = null;
const AUTOSAVE_DELAY_MS = 2000; // Save only after 2 seconds of inactivity

// Memory monitoring
const MAX_MEMORY_MB = 1000; // Maximum memory usage before cleanup
const FOG_CELL_LIMIT = 5000; // Maximum fog cells per level
const MAX_MESSAGE_SIZE = 1024 * 1024; // 1MB max message size
const MAX_CLIENTS = 50; // Maximum number of concurrent clients
const MAX_HISTORY_EVENTS = 200; // Maximum number of history events to retain

function checkMemoryAndCleanup() {
  const memUsage = process.memoryUsage();
  const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  
  if (memUsageMB > MAX_MEMORY_MB) {
    console.warn(`[SERVER] High memory usage detected: ${memUsageMB}MB, performing cleanup...`);
    
    // Clean up old undo/redo history
    if (state.undoRedo.undoStack.length > 10) {
      const removed = state.undoRedo.undoStack.splice(0, state.undoRedo.undoStack.length - 10);
      console.log(`[SERVER] Cleaned up ${removed.length} old undo actions`);
    }
    
    // Clean up fog cells if too many
    for (const [levelId, fogSet] of state.fog.entries()) {
      if (fogSet.size > FOG_CELL_LIMIT) {
        const cellsArray = Array.from(fogSet);
        const toRemove = cellsArray.slice(0, fogSet.size - FOG_CELL_LIMIT);
        toRemove.forEach(cell => fogSet.delete(cell));
        console.log(`[SERVER] Cleaned up ${toRemove.length} fog cells from level ${levelId}`);
      }
    }
    
    // Force garbage collection if available
    if (global.gc) {
      global.gc();
      const newMemUsage = process.memoryUsage();
      const newMemUsageMB = Math.round(newMemUsage.heapUsed / 1024 / 1024);
      console.log(`[SERVER] Memory after cleanup: ${newMemUsageMB}MB (freed ${memUsageMB - newMemUsageMB}MB)`);
    }
  }
}

// ---- Persistence helpers ----
async function ensureDataRoot() {
  await fs.mkdir(DATA_ROOT, { recursive: true });
}

function withinDataRoot(rel: string): string | null {
  const target = path.resolve(DATA_ROOT, rel);
  if (!target.startsWith(path.resolve(DATA_ROOT) + path.sep)) return null;
  return target;
}

async function readJSON<T = any>(file: string): Promise<T> {
  // Read as UTF-8 string and strip a possible UTF-8 BOM which would break JSON.parse
  let buf = await fs.readFile(file, "utf8");
  if (buf && buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1);
  try {
    return JSON.parse(buf) as T;
  } catch (e: any) {
    // Attempt to salvage by trimming any trailing garbage after the first complete JSON value
    try {
      const end = findEndOfFirstJSONValue(buf);
      if (end != null && end > 0) {
        const trimmed = buf.slice(0, end).trimEnd();
        const parsed = JSON.parse(trimmed) as T;
        try {
          console.warn(`[LOC][server] readJSON: trailing content trimmed for ${path.relative(DATA_ROOT, file)} keptChars=${end}/${buf.length}`);
        } catch {}
        return parsed;
      }
    } catch {}
    throw e;
  }
}

// Find the end index (exclusive) of the first complete JSON value in a string.
// Handles objects/arrays, strings with escapes, and nesting. Returns null if not found.
function findEndOfFirstJSONValue(s: string): number | null {
  let i = 0;
  const n = s.length;
  // skip leading whitespace
  while (i < n && /\s/.test(s[i]!)) i++;
  if (i >= n) return null;
  const start = i;
  const ch = s[i]!;
  // For primitives, JSON.parse would succeed or fail differently; we care about object/array roots
  if (ch !== '{' && ch !== '[') return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (; i < n; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = false; continue; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{' || c === '[') { depth++; continue; }
    if (c === '}' || c === ']') { depth--; if (depth === 0) { i++; break; } continue; }
  }
  if (depth !== 0) return null;
  // include trailing whitespace after the value
  while (i < n && /\s/.test(s[i]!)) i++;
  return i;
}

async function writeJSON(file: string, obj: any) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}

async function tryReadLastUsed(): Promise<string | null> {
  try {
    const data = await readJSON<{ path: string }>(LAST_USED_FILE);
    if (!data?.path) return null;
    const safe = withinDataRoot(data.path);
    return safe ? data.path : null;
  } catch {
    return null;
  }
}

async function writeLastUsed(relPath: string) {
  await writeJSON(LAST_USED_FILE, { path: relPath });
}


async function buildLocationsTree(): Promise<LocationTreeNode[]> {
  const seenLocationIds = new Set<string>();
  
  async function walk(dirRel: string): Promise<LocationTreeNode[]> {
    const dirAbs = withinDataRoot(dirRel) ?? DATA_ROOT;
    const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
    const folders: LocationTreeNode[] = [];
    const files: LocationTreeNode[] = [];
    for (const ent of entries) {
      if (ent.name.startsWith(".")) continue;
      if (ent.isDirectory()) {
        const children = await walk(path.join(dirRel, ent.name));
        folders.push({ type: "folder", name: ent.name, path: path.join(dirRel, ent.name) + path.sep, children });
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) {
        if (ent.name === "last-used.json") continue; // hide internal meta file if present
        const rel = path.join(dirRel, ent.name);
        const fileAbs = withinDataRoot(rel)!;
        try { console.debug(`[LOC][server] scanning file: ${rel}`); } catch {}
        let locationName: string | undefined;
        let locationId: string | undefined;
        let include = false;
        try {
          const snap = await readJSON<GameSnapshot>(fileAbs);
          const loc: any = (snap as any)?.location;
          const hasValidLocation = !!loc && typeof loc.name === "string" && typeof loc.id === "string" && Array.isArray(loc.levels);
          if (hasValidLocation) {
            locationName = loc.name;
            locationId = loc.id;
            // Check for duplicate location IDs
            if (seenLocationIds.has(locationId!)) {
              console.warn(`[LOC][server] Duplicate location ID detected: ${locationId} in file ${rel}. Skipping duplicate.`);
              continue;
            }
            seenLocationIds.add(locationId!);
            include = true;
          }
        } catch (e: any) {
          try {
            // Inspect first few bytes to detect encoding/BOM issues
            let firstBytes = "";
            try {
              const raw = await fs.readFile(fileAbs as string);
              firstBytes = Array.from(raw.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
            } catch {}
            console.warn(`[LOC][server] failed to parse JSON: ${rel} err=${e?.message ?? e} firstBytes=[${firstBytes}]`);
          } catch {}
        }
        if (include) {
          files.push({ type: "file", name: ent.name.replace(/\.json$/i, ""), path: rel, locationName });
          try { console.debug(`[LOC][server] include file: ${rel} (name="${locationName}", id="${locationId}")`); } catch {}
        } else {
          try { console.debug(`[LOC][server] skip file: ${rel} (no valid location)`); } catch {}
        }
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, "en"));
    files.sort((a, b) => a.name.localeCompare(b.name, "en"));
    return [...folders, ...files];
  }
  return walk("");
}

function roleFromInvite(inv?: string | null): Role {
  console.log(`[SERVER] roleFromInvite: inv=${inv}`);
  // Always return DM as default, ignore invite codes for now
  console.log(`[SERVER] roleFromInvite: returning DM (default)`);
  return "DM";
}

function send(ws: import("ws").WebSocket, msg: ServerToClient) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      console.warn(`[SERVER] Attempted to send message to closed WebSocket: ${ws.readyState}`);
    }
  } catch (error) {
    console.error(`[SERVER] Failed to send message:`, error);
  }
}

function broadcast(events: Event[]) {
  console.log(`[SERVER] Broadcasting ${events.length} events to ${state.clients.size} clients:`, events.map(e => e.type));
  for (const c of state.clients.values()) {
    send(c.socket, { t: "statePatch", events });
  }
}

function getClientDisplayName(client: ClientRec | null | undefined): string {
  if (!client) return "System";
  if (client.user?.username) return client.user.username;
  return client.role === "DM" ? "DM" : "Player";
}

function broadcastHistoryEvent(event: HistoryEvent) {
  for (const c of state.clients.values()) {
    if (c.role === "DM") {
      send(c.socket, { t: "historyEvent", event });
    }
  }
}

function recordHistoryEvent(
  client: ClientRec | null,
  info: {
    actionType: string;
    description: string;
    details?: HistoryEventDetails;
    actionId?: string;
    actorId?: ID | null;
    actorName?: string;
    actorRole?: Role;
  }
): HistoryEvent {
  const details = info.details
    ? {
        ...info.details,
        from: info.details.from
          ? {
              ...info.details.from,
              pos: info.details.from.pos ? { ...info.details.from.pos } : undefined
            }
          : undefined,
        to: info.details.to
          ? {
              ...info.details.to,
              pos: info.details.to.pos ? { ...info.details.to.pos } : undefined
            }
          : undefined,
        changes: info.details.changes ? info.details.changes.map(c => ({ ...c })) : undefined,
        targets: info.details.targets ? info.details.targets.map(t => ({ ...t })) : undefined
      }
    : undefined;
  const event: HistoryEvent = {
    id: randomUUID(),
    timestamp: Date.now(),
    actionType: info.actionType,
    description: info.description,
    actorId: info.actorId ?? client?.user?.id ?? client?.id ?? null,
    actorName: info.actorName ?? getClientDisplayName(client),
    actorRole: info.actorRole ?? client?.role,
    actionId: info.actionId,
    details
  };
  state.history.push(event);
  if (state.history.length > MAX_HISTORY_EVENTS) {
    state.history.splice(0, state.history.length - MAX_HISTORY_EVENTS);
  }
  if (info.actionId) {
    let arr = state.historyByAction.get(info.actionId);
    if (!arr) {
      arr = [];
      state.historyByAction.set(info.actionId, arr);
    }
    arr.push(event);
    const actionRecord =
      (state.undoRedo.undoStack.find(a => a.id === info.actionId) as ServerActionSnapshot | undefined) ||
      (state.undoRedo.redoStack.find(a => a.id === info.actionId) as ServerActionSnapshot | undefined);
    if (actionRecord) {
      actionRecord.historyEvents = actionRecord.historyEvents ? [...actionRecord.historyEvents, event] : [event];
    }
  }
  broadcastHistoryEvent(event);
  return event;
}

function sendHistorySnapshot(client: ClientRec) {
  if (client.role !== "DM") return;
  send(client.socket, { t: "historySnapshot", events: state.history });
}

// Undo/Redo system functions
function createGameSnapshot(): GameSnapshot {
  const floors: { levelId: ID; pos: Vec2; kind: FloorKind }[] = [];
  for (const [levelId, floorMap] of state.floors) {
    for (const [posKey, kind] of floorMap) {
      const [x, y] = posKey.split(',').map(Number);
      floors.push({ levelId, pos: { x, y }, kind });
    }
  }
  
  // Include fog state in events - OPTIMIZED: only save fog deltas, not full state
  const events: Event[] = [];
  const fogLevelsCount = state.fog.size;
  let totalFogCells = 0;
  
  for (const [levelId, fogSet] of state.fog.entries()) {
    const cells = Array.from(fogSet).map((k) => {
      const [xs, ys] = k.split(",");
      return { x: Number(xs), y: Number(ys) } as Vec2;
    });
    totalFogCells += cells.length;
    
    // Only include fog if there are revealed cells and it's not too many
    if (cells.length > 0 && cells.length < FOG_CELL_LIMIT) {
      events.push({ type: "fogRevealed", levelId, cells } as any);
    } else if (cells.length >= FOG_CELL_LIMIT) {
      console.warn(`[SERVER] Skipping fog save for level ${levelId}: too many cells (${cells.length})`);
    }
  }
  
  if (fogLevelsCount > 0) {
    console.log(`[SERVER] createGameSnapshot: fog levels: ${fogLevelsCount}, total cells: ${totalFogCells}, events: ${events.length}`);
  }
  
  return {
    location: deepCopy(state.location),
    tokens: Array.from(state.tokens.values()).map((tok) => deepCopy(tok)),
    assets: Array.from(state.assets.values()).map((asset) => deepCopy(asset)),
    floors,
    events
  };
}

function createFogSnapshot(levelIds: ID | ID[]): Partial<GameSnapshot> {
  const ids = Array.isArray(levelIds) ? levelIds : [levelIds];
  const events: Event[] = [];
  for (const levelId of ids) {
    const fogSet = state.fog.get(levelId) ?? new Set<string>();
    const cells = Array.from(fogSet).map((key) => {
      const [xs, ys] = key.split(",");
      return { x: Number(xs), y: Number(ys) } as Vec2;
    });
    events.push({ type: "fogRevealed", levelId, cells } as any);
  }
  return { events, fogLevels: ids } as Partial<GameSnapshot>;
}

function createActionSnapshot(actionType: string, description: string, beforeState: Partial<GameSnapshot>, afterState: Partial<GameSnapshot>): ServerActionSnapshot {
  return {
    id: randomUUID(),
    timestamp: Date.now(),
    actionType,
    beforeState,
    afterState,
    description
  };
}

function pushToUndoStack(action: ServerActionSnapshot) {
  const { undoRedo } = state;
  
  // Clear redo stack when new action is performed
  undoRedo.redoStack = [];
  
  // Add to undo stack
  undoRedo.undoStack.push(action);
  
  // Maintain max stack size
  if (undoRedo.undoStack.length > undoRedo.maxStackSize) {
    undoRedo.undoStack.shift();
  }
  
  console.log(`[SERVER] Added action to undo stack: ${action.description}, stack size: ${undoRedo.undoStack.length}`);
  
  // Check memory usage after adding action
  checkMemoryAndCleanup();
  
  // Notify clients about undo/redo state
  broadcastUndoRedoState();
}

function performUndo(): boolean {
  const { undoRedo } = state;

  console.log(`[SERVER] performUndo called, stack size: ${undoRedo.undoStack.length}`);

  if (undoRedo.undoStack.length === 0) {
    console.log(`[SERVER] performUndo: no actions to undo`);
    return false;
  }

  const action = undoRedo.undoStack.pop()! as ServerActionSnapshot;
  console.log(`[SERVER] performUndo: undoing action: ${action.description}`);

  // Apply the before state
  applySnapshot(action.beforeState);

  // Move to redo stack
  undoRedo.redoStack.push(action);

  // Remove associated history events
  const removedEvents = state.historyByAction.get(action.id) ?? action.historyEvents ?? ([] as HistoryEvent[]);
  if (removedEvents.length > 0) {
    const removedIds = new Set(removedEvents.map(ev => ev.id));
    state.history = state.history.filter(ev => !removedIds.has(ev.id));
    state.historyByAction.delete(action.id);
    for (const client of state.clients.values()) {
      if (client.role === "DM") {
        if (removedIds.size > 0) {
          send(client.socket, { t: "historyRemoved", eventIds: Array.from(removedIds) } as any);
        }
      }
    }
  }

  // Send events for all updated objects
  const events: Event[] = [];
  for (const asset of state.assets.values()) {
    events.push({ type: "assetUpdated", asset } as any);
  }
  for (const token of state.tokens.values()) {
    events.push({ type: "tokenUpdated", token } as any);
  }

  broadcastUndoRedoState();
  broadcast([{ type: "undoPerformed", actionId: action.id } as any]);
  if (events.length > 0) {
    broadcast(events);
  }

  console.log(`[SERVER] performUndo: completed, redo stack size: ${undoRedo.redoStack.length}`);
  return true;
}

function performRedo(): boolean {
  const { undoRedo } = state;

  if (undoRedo.redoStack.length === 0) {
    return false;
  }

  const action = undoRedo.redoStack.pop()! as ServerActionSnapshot;
  console.log(`[SERVER] performRedo: redoing action: ${action.description}`);

  applySnapshot(action.afterState);
  undoRedo.undoStack.push(action);

  const events: Event[] = [];
  for (const asset of state.assets.values()) {
    events.push({ type: "assetUpdated", asset } as any);
  }
  for (const token of state.tokens.values()) {
    events.push({ type: "tokenUpdated", token } as any);
  }

  const replayEvents = state.historyByAction.get(action.id) ?? action.historyEvents ?? ([] as HistoryEvent[]);
  let historyAdded: HistoryEvent[] | undefined;
  if (replayEvents.length > 0) {
    const existingIds = new Set(state.history.map(ev => ev.id));
    historyAdded = replayEvents
      .filter(ev => !existingIds.has(ev.id))
      .map(ev => ({ ...ev, timestamp: Date.now() }));
    if (historyAdded && historyAdded.length > 0) {
      state.history = [...historyAdded, ...state.history].slice(0, MAX_HISTORY_EVENTS);
      state.historyByAction.set(action.id, historyAdded);
      for (const client of state.clients.values()) {
        if (client.role === "DM") {
          send(client.socket, { t: "historyAdded", events: historyAdded } as any);
        }
      }
    }
  }

  broadcastUndoRedoState();
  broadcast([{ type: "redoPerformed", actionId: action.id } as any]);
  if (events.length > 0) {
    broadcast(events);
  }

  return true;
}

function broadcastUndoRedoState() {
  console.log(`[SERVER] Broadcasting undoRedoState to ${state.clients.size} clients: undo=${state.undoRedo.undoStack.length}, redo=${state.undoRedo.redoStack.length}`);
  for (const c of state.clients.values()) {
    send(c.socket, { 
      t: "undoRedoState", 
      undoStack: state.undoRedo.undoStack, 
      redoStack: state.undoRedo.redoStack 
    });
  }
}

function clearUndoRedoHistory() {
  state.undoRedo.undoStack = [];
  state.undoRedo.redoStack = [];
  broadcastUndoRedoState();
}

function persistIfAutosave() {
  if (!currentSavePath) return;
  
  // Clear existing timer
  if (autosaveTimer) {
    clearTimeout(autosaveTimer);
  }
  
  // Set new timer with debouncing
  autosaveTimer = setTimeout(async () => {
    try {
      const safe = withinDataRoot(currentSavePath!);
      if (!safe) return;
      
      // Check memory usage before saving
      const memUsage = process.memoryUsage();
      const memUsageMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      
      if (memUsageMB > 500) { // Warn if memory usage is high
        console.warn(`[SERVER] High memory usage before autosave: ${memUsageMB}MB`);
      }
      
      const { snapshot: snap } = snapshot();
      await writeJSON(safe, snap);
      
      console.log(`[SERVER] Autosaved (memory: ${memUsageMB}MB)`);
    } catch (e) {
      console.error("[SERVER] Autosave failed:", e);
    }
  }, AUTOSAVE_DELAY_MS);
}

function onMessage(client: ClientRec, data: any) {
  let msg: ClientToServer | undefined;
  try {
    const dataStr = String(data);
    if (dataStr.length > MAX_MESSAGE_SIZE) {
      console.warn(`[SERVER] Message too large from client ${client.id}: ${dataStr.length} bytes`);
      return send(client.socket, { t: "error", message: "Message too large" });
    }
    msg = JSON.parse(dataStr);
  } catch (e) {
    console.warn(`[SERVER] Invalid JSON from client ${client.id}:`, e);
    return send(client.socket, { t: "error", message: "Invalid JSON" });
  }

  if (!msg || typeof msg !== "object" || !("t" in msg)) {
    console.warn(`[SERVER] Invalid message format from client ${client.id}:`, msg);
    return;
  }

  switch (msg.t) {
    case "join": {
      // Handle role preference from client
      const preferredRole = (msg as any).preferredRole;
      if (preferredRole === "DM" || preferredRole === "PLAYER") {
        const prevRole = client.role;
        client.role = preferredRole;
        console.log(`[SERVER] Client ${client.id} joined with preferred role: ${preferredRole}`);
        if (client.role === "DM" && prevRole !== "DM") {
          sendHistorySnapshot(client);
        }
      }
      break;
    }
    case "ping": {
      send(client.socket, { t: "pong" });
      break;
    }
    case "spawnToken": {
      if (client.role !== "DM") return;
      const kind = (msg as any).kind === "npc" ? "npc" : "player";
      const level: ID = (msg as any).levelId || state.location.levels[0]?.id || "L1";
      const basePos: Vec2 = (msg as any).pos || state.location.levels[0]?.spawnPoint || { x: 5, y: 5 };
      ensureDefaultFloorsForLevel(level);
      const levelFloors = state.floors.get(level);
      const parseKey = (key: string): Vec2 => {
        const [sx, sy] = key.split(",");
        return { x: Number.parseInt(sx, 10) || 0, y: Number.parseInt(sy, 10) || 0 };
      };
      let pos: Vec2 = { x: Math.floor(basePos.x), y: Math.floor(basePos.y) };
      if (!hasFloorAt(level, pos)) {
        const spawn = state.location.levels.find((lvl) => lvl.id === level)?.spawnPoint ?? { x: 5, y: 5 };
        if (hasFloorAt(level, spawn)) {
          pos = { x: Math.floor(spawn.x), y: Math.floor(spawn.y) };
        } else if (levelFloors && levelFloors.size > 0) {
          const firstIter = levelFloors.keys().next();
          if (!firstIter.done && typeof firstIter.value === "string") {
            pos = parseKey(firstIter.value);
          } else {
            return;
          }
        } else {
          return;
        }
      }
      function occupied(p: Vec2): boolean {
        for (const t of state.tokens.values()) {
          if (t.levelId === level && t.pos.x === p.x && t.pos.y === p.y) return true;
        }
        return false;
      }
      if (occupied(pos)) {
        const dirs = [
          { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
          { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
        ];
        for (const d of dirs) {
          const p = { x: pos.x + d.x, y: pos.y + d.y };
          if (!hasFloorAt(level, p)) continue;
          if (!occupied(p)) { pos = p; break; }
        }
      }
      
      // Create snapshot before action
      const beforeState = createGameSnapshot();
      
      const owner: ID = (msg as any).owner || client.id;
      const t = kind === "npc" ? makeNPCToken(owner, level, pos) : makePlayerToken(owner, level, pos);
      state.tokens.set(t.id, t);
      
      // Create snapshot after action and push to undo stack
      const afterState = createGameSnapshot();
      const action = createActionSnapshot(
        "spawnToken",
        `Creating ${kind === "npc" ? "NPC" : "player"} at (${pos.x}, ${pos.y})`,
        beforeState,
        afterState
      );
      pushToUndoStack(action);
      const tokenLabel = describeToken(t);
      const tokenDisplay = tokenLabel.startsWith("Token ") ? tokenLabel : `"${tokenLabel}"`;
      const history = recordHistoryEvent(client, {
        actionType: action.actionType,
        description: `Created ${kind === "npc" ? "NPC" : "player"} ${tokenDisplay} at ${formatCoords(pos)}`,
        actionId: action.id,
        details: {
          targetType: "token",
          targetId: t.id,
          targetName: tokenLabel,
          targetKind: kind,
          levelId: t.levelId,
          to: { levelId: t.levelId, pos: { ...t.pos } }
        }
      });
      action.historyEvents = action.historyEvents ? [...action.historyEvents, history] : [history];
      
      broadcast([{ type: "tokenSpawned", token: t } as any]);
      persistIfAutosave();
      break;
    }
    case "moveToken": {
      const tok = state.tokens.get(msg.tokenId);
      if (!tok) return;
      if (client.role !== "DM" && tok.owner !== client.id) return;
      const previousPos: Vec2 = { x: tok.pos.x, y: tok.pos.y };
      const previousLevel = tok.levelId;
      
      // Create snapshot before action (only for DM moves)
      const beforeState = client.role === "DM" ? createGameSnapshot() : null;
      
      // Normalize target to integer grid
      const target: Vec2 = { x: Math.floor(msg.pos.x), y: Math.floor(msg.pos.y) };
      ensureDefaultFloorsForLevel(msg.levelId);
      if (!hasFloorAt(msg.levelId, target)) return;
      const pos: Vec2 = target;
      tok.pos = pos;
      tok.levelId = msg.levelId;
      const events: Event[] = [];
      events.push({ type: "tokenMoved", tokenId: tok.id, pos, levelId: tok.levelId } as any);
      // Auto-reveal fog based on token's vision radius, but ONLY for player tokens and ONLY in automatic mode
      const isNPC = (tok as any).kind === "npc";
      const isAutomaticMode = !state.location?.fogMode || state.location.fogMode === "automatic";
      if (!isNPC && isAutomaticMode) {
        const vr = Math.max(0, Math.min(20, Math.round((tok.vision as any)?.radius ?? 0)));
        if (vr > 0) {
          const fog = getFogSet(tok.levelId);
          const cells = cellsInRadius(tok.pos, vr);
          const added: Vec2[] = [];
          for (const c of cells) {
            const k = cellKey(c);
            if (!fog.has(k)) { fog.add(k); added.push({ x: c.x, y: c.y }); }
          }
          if (added.length > 0) events.push({ type: "fogRevealed", levelId: tok.levelId, cells: added } as any);
        }
      }
      
      // Create snapshot after action and push to undo stack (only for DM moves)
      let undoActionId: string | undefined;
      if (beforeState && client.role === "DM") {
        const afterState = createGameSnapshot();
        const action = createActionSnapshot(
          "moveToken",
          `Moving token to (${pos.x}, ${pos.y})`,
          beforeState,
          afterState
        );
        pushToUndoStack(action);
        undoActionId = action.id;
      }
      if (previousPos.x !== pos.x || previousPos.y !== pos.y || previousLevel !== tok.levelId) {
        const tokenLabel = describeToken(tok);
        const tokenDisplay = tokenLabel.startsWith("Token ") ? tokenLabel : `"${tokenLabel}"`;
        const movedBetweenLevels = previousLevel !== tok.levelId;
        const description = movedBetweenLevels
          ? `Moved ${tokenDisplay} from ${previousLevel} ${formatCoords(previousPos)} to ${tok.levelId} ${formatCoords(pos)}`
          : `Moved ${tokenDisplay} from ${formatCoords(previousPos)} to ${formatCoords(pos)}`;
        const history = recordHistoryEvent(client, {
          actionType: "moveToken",
          description,
          actionId: undoActionId,
          details: {
            targetType: "token",
            targetId: tok.id,
            targetName: tokenLabel,
            targetKind: (tok as any).kind,
            levelId: tok.levelId,
            from: { levelId: previousLevel, pos: { ...previousPos } },
            to: { levelId: tok.levelId, pos: { ...pos } }
          }
        });
        if (undoActionId) {
          const undoAction = state.undoRedo.undoStack.find(a => a.id === undoActionId) as ServerActionSnapshot | undefined;
          if (undoAction) {
            undoAction.historyEvents = undoAction.historyEvents ? [...undoAction.historyEvents, history] : [history];
          }
        }
      }
      
      broadcast(events);
      persistIfAutosave();
      break;
    }
    case "updateToken": {
      const tok = state.tokens.get(msg.tokenId);
      if (!tok) break;
      // Only DM or token owner can update
      if (client.role !== "DM" && tok.owner !== client.id) break;
      const prevHp = typeof tok.hp === "number" ? tok.hp : null;
      const prevAc = typeof tok.ac === "number" ? tok.ac : null;
      const prevStats = tok.stats ? { ...tok.stats } : undefined;
      const prevDead = Boolean((tok as any).dead);
      const patch = msg.patch as Partial<Token>;
      // Apply whitelisted fields
      if (typeof patch.name === "string") tok.name = String(patch.name).slice(0, 64);
      if (typeof patch.hp === "number") tok.hp = Math.max(0, Math.min(999, Math.round(patch.hp)));
      if (typeof patch.ac === "number") tok.ac = Math.max(0, Math.min(50, Math.round(patch.ac)));
      if (typeof (patch as any).tint === "number") (tok as any).tint = (patch as any).tint >>> 0;
      if (patch.stats && typeof patch.stats === "object") {
        tok.stats = { ...(tok.stats ?? {}), ...patch.stats } as any;
        // sanitize numeric stats if present
        const keys: (keyof NonNullable<typeof tok.stats>)[] = ["str","dex","con","int","wis","cha","hp","ac"] as any;
        for (const k of keys) {
          const v: any = (tok.stats as any)[k];
          if (typeof v === "number") (tok.stats as any)[k] = Math.max(0, Math.min(999, Math.round(v)));
        }
      }
      if (typeof patch.notes === "string") {
        tok.notes = patch.notes.slice(0, 2000);
      } else if ((patch as any).notes === null) {
        delete (tok as any).notes;
      }
      if (typeof (patch as any).dead === "boolean") {
        (tok as any).dead = (patch as any).dead;
      }
      if (patch.vision && typeof patch.vision === "object") {
        const vr = Math.max(0, Math.min(20, Math.round((patch.vision as any).radius ?? (tok.vision?.radius ?? 8))));
        const ang = (patch.vision as any).angle ?? (tok.vision?.angle ?? 360);
        tok.vision = { radius: vr, angle: ang };
      }
      if (typeof (patch as any).icon === "string") {
        (tok as any).icon = (patch as any).icon;
      }
      state.tokens.set(tok.id, tok);
      const tokenLabel = describeToken(tok);
      const tokenDisplay = tokenLabel.startsWith("Token ") ? tokenLabel : `"${tokenLabel}"`;
      const fieldChanges: HistoryEventChange[] = [];
      const descriptionParts: string[] = [];
      if (typeof patch.hp === "number" && tok.hp !== prevHp) {
        fieldChanges.push({ field: "hp", from: prevHp, to: tok.hp });
        descriptionParts.push(`HP ${prevHp ?? "—"} → ${tok.hp ?? "—"}`);
      }
      if (typeof patch.ac === "number" && tok.ac !== prevAc) {
        fieldChanges.push({ field: "ac", from: prevAc, to: tok.ac });
        descriptionParts.push(`AC ${prevAc ?? "—"} → ${tok.ac ?? "—"}`);
      }
      if (patch.stats && typeof patch.stats === "object") {
        for (const [key, value] of Object.entries(patch.stats)) {
          if (typeof value !== "number") continue;
          const statKey = key as keyof NonNullable<Token["stats"]>;
          const beforeValue = prevStats ? (prevStats as any)[statKey] : undefined;
          const afterValue = tok.stats ? (tok.stats as any)[statKey] : undefined;
          if (beforeValue === afterValue) continue;
          const label = key.toUpperCase();
          fieldChanges.push({ field: `stats.${key}`, from: beforeValue ?? null, to: afterValue ?? null });
          descriptionParts.push(`${label} ${beforeValue ?? "—"} → ${afterValue ?? "—"}`);
        }
      }
      const deadPatched = typeof (patch as any).dead === "boolean";
      const currentDead = Boolean((tok as any).dead);
      const deadChanged = deadPatched && currentDead !== prevDead;
      if (deadChanged) {
        fieldChanges.push({ field: "dead", from: prevDead, to: currentDead });
      }
      if (descriptionParts.length > 0 || deadChanged) {
        let description: string;
        if (deadChanged && descriptionParts.length === 0) {
          description = currentDead ? `Marked ${tokenDisplay} as dead` : `Marked ${tokenDisplay} as alive`;
        } else {
          const summary = descriptionParts.join(", ");
          description = `Updated ${tokenDisplay}: ${summary}`;
          if (deadChanged) {
            description += currentDead ? ", marked as dead" : ", marked as alive";
          }
        }
        recordHistoryEvent(client, {
          actionType: "updateToken",
          description,
          details: {
            targetType: "token",
            targetId: tok.id,
            targetName: tokenLabel,
            targetKind: (tok as any).kind,
            levelId: tok.levelId,
            changes: fieldChanges.length > 0 ? fieldChanges : undefined
          }
        });
      }
      broadcast([{ type: "tokenUpdated", token: tok } as any]);
      persistIfAutosave();
      break;
    }
    case "reorderToken": {
      // Only DM or token owner can reorder
      const tok = state.tokens.get(msg.tokenId);
      if (!tok) break;
      if (client.role !== "DM" && tok.owner !== client.id) break;
      
      // For top/bottom: compare with all objects on level (assets + tokens)
      // For up/down: compare only with objects at same position
      
      // Determine new zIndex based on direction
      let newZIndex: number | undefined;
      switch (msg.direction) {
        case "top": {
          // Move to highest zIndex + 1 (considering all objects on level)
          const allAssetsOnLevel = Array.from(state.assets.values())
            .filter(a => a.levelId === tok.levelId);
          const allTokensOnLevel = Array.from(state.tokens.values())
            .filter(t => t.levelId === tok.levelId);
          
          const maxAssetZ = allAssetsOnLevel.length > 0 
            ? Math.max(...allAssetsOnLevel.map(a => (a as any).zIndex ?? 0)) 
            : 0;
          const maxTokenZ = allTokensOnLevel.length > 0 
            ? Math.max(...allTokensOnLevel.map(t => (t as any).zIndex ?? 0)) 
            : 0;
          
          newZIndex = Math.max(maxAssetZ, maxTokenZ) + 1;
          break;
        }
        case "bottom": {
          // Move to lowest zIndex - 1 (considering all objects on level)
          const allAssetsOnLevel = Array.from(state.assets.values())
            .filter(a => a.levelId === tok.levelId);
          const allTokensOnLevel = Array.from(state.tokens.values())
            .filter(t => t.levelId === tok.levelId);
          
          const minAssetZ = allAssetsOnLevel.length > 0 
            ? Math.min(...allAssetsOnLevel.map(a => (a as any).zIndex ?? 0)) 
            : 0;
          const minTokenZ = allTokensOnLevel.length > 0 
            ? Math.min(...allTokensOnLevel.map(t => (t as any).zIndex ?? 0)) 
            : 0;
          
          newZIndex = Math.min(minAssetZ, minTokenZ) - 1;
          break;
        }
        case "up":
        case "down": {
          // For relative moves, only consider tokens at same position
          const tokensAtPos = Array.from(state.tokens.values())
            .filter(t => t.levelId === tok.levelId && t.pos.x === tok.pos.x && t.pos.y === tok.pos.y)
            .sort((a, b) => ((a as any).zIndex ?? 0) - ((b as any).zIndex ?? 0));
          
          if (tokensAtPos.length <= 1) break; // Nothing to swap with
          
          const currentIdx = tokensAtPos.findIndex(t => t.id === tok.id);
          if (currentIdx === -1) break;
          
          if (msg.direction === "up") {
            // Swap with token above (higher zIndex)
            if (currentIdx < tokensAtPos.length - 1) {
              const above = tokensAtPos[currentIdx + 1];
              newZIndex = (above as any).zIndex ?? 0;
              (above as any).zIndex = (tok as any).zIndex ?? 0;
              state.tokens.set(above.id, above);
              broadcast([{ type: "tokenUpdated", token: above } as any]);
            }
          } else {
            // Swap with token below (lower zIndex)
            if (currentIdx > 0) {
              const below = tokensAtPos[currentIdx - 1];
              newZIndex = (below as any).zIndex ?? 0;
              (below as any).zIndex = (tok as any).zIndex ?? 0;
              state.tokens.set(below.id, below);
              broadcast([{ type: "tokenUpdated", token: below } as any]);
            }
          }
          break;
        }
      }
      
      if (newZIndex !== undefined) {
        (tok as any).zIndex = newZIndex;
        state.tokens.set(tok.id, tok);
        broadcast([{ type: "tokenUpdated", token: tok } as any]);
        persistIfAutosave();
      }
      break;
    }
    case "reorderAsset": {
      console.log(`[SERVER] reorderAsset received: assetId=${msg.assetId}, direction=${msg.direction}, role=${client.role}`);
      if (client.role !== "DM") {
        console.log(`[SERVER] reorderAsset rejected: not DM`);
        break; // Only DM can reorder assets
      }
      
      const asset = state.assets.get(msg.assetId);
      if (!asset) {
        console.log(`[SERVER] reorderAsset rejected: asset not found. Looking for: ${msg.assetId}`);
        console.log(`[SERVER] Available asset IDs:`, Array.from(state.assets.keys()).slice(0, 5));
        break;
      }
      console.log(`[SERVER] reorderAsset: asset found at (${asset.pos.x}, ${asset.pos.y}), current zIndex=${(asset as any).zIndex ?? 'undefined'}`);
      
      // For top/bottom: compare with all objects on level (assets + tokens)
      // For up/down: compare only with objects at same position
      
      // Determine new zIndex based on direction
      let newZIndex: number | undefined;
      switch (msg.direction) {
        case "top": {
          // Move to highest zIndex + 1 (considering all objects on level)
          const allAssetsOnLevel = Array.from(state.assets.values())
            .filter(a => a.levelId === asset.levelId);
          const allTokensOnLevel = Array.from(state.tokens.values())
            .filter(t => t.levelId === asset.levelId);
          
          const maxAssetZ = allAssetsOnLevel.length > 0 
            ? Math.max(...allAssetsOnLevel.map(a => (a as any).zIndex ?? 0)) 
            : 0;
          const maxTokenZ = allTokensOnLevel.length > 0 
            ? Math.max(...allTokensOnLevel.map(t => (t as any).zIndex ?? 0)) 
            : 0;
          
          // Both assets and tokens use same zIndex range, so we add to max found
          newZIndex = Math.max(maxAssetZ, maxTokenZ) + 1;
          break;
        }
        case "bottom": {
          // Move to lowest zIndex - 1 (considering all objects on level)
          const allAssetsOnLevel = Array.from(state.assets.values())
            .filter(a => a.levelId === asset.levelId);
          const allTokensOnLevel = Array.from(state.tokens.values())
            .filter(t => t.levelId === asset.levelId);
          
          const minAssetZ = allAssetsOnLevel.length > 0 
            ? Math.min(...allAssetsOnLevel.map(a => (a as any).zIndex ?? 0)) 
            : 0;
          const minTokenZ = allTokensOnLevel.length > 0 
            ? Math.min(...allTokensOnLevel.map(t => (t as any).zIndex ?? 0)) 
            : 0;
          
          newZIndex = Math.min(minAssetZ, minTokenZ) - 1;
          break;
        }
        case "up":
        case "down": {
          // For relative moves, only consider objects at same position
          const assetsAtPos = Array.from(state.assets.values())
            .filter(a => a.levelId === asset.levelId && a.pos.x === asset.pos.x && a.pos.y === asset.pos.y)
            .sort((a, b) => ((a as any).zIndex ?? 0) - ((b as any).zIndex ?? 0));
          
          if (assetsAtPos.length <= 1) break; // Nothing to swap with
          
          const currentIdx = assetsAtPos.findIndex(a => a.id === asset.id);
          if (currentIdx === -1) break;
          
          if (msg.direction === "up") {
            // Swap with asset above (higher zIndex)
            if (currentIdx < assetsAtPos.length - 1) {
              const above = assetsAtPos[currentIdx + 1];
              newZIndex = (above as any).zIndex ?? 0;
              (above as any).zIndex = (asset as any).zIndex ?? 0;
              state.assets.set(above.id, above);
              broadcast([{ type: "assetUpdated", asset: above } as any]);
            }
          } else {
            // Swap with asset below (lower zIndex)
            if (currentIdx > 0) {
              const below = assetsAtPos[currentIdx - 1];
              newZIndex = (below as any).zIndex ?? 0;
              (below as any).zIndex = (asset as any).zIndex ?? 0;
              state.assets.set(below.id, below);
              broadcast([{ type: "assetUpdated", asset: below } as any]);
            }
          }
          break;
        }
      }
      
      if (newZIndex !== undefined) {
        console.log(`[SERVER] reorderAsset: setting zIndex from ${(asset as any).zIndex ?? 'undefined'} to ${newZIndex}`);
        (asset as any).zIndex = newZIndex;
        state.assets.set(asset.id, asset);
        broadcast([{ type: "assetUpdated", asset } as any]);
        console.log(`[SERVER] reorderAsset: broadcasted assetUpdated event`);
        persistIfAutosave();
      } else {
        console.log(`[SERVER] reorderAsset: newZIndex is undefined, no changes made`);
      }
      break;
    }
    case "revealFog": {
      if (client.role !== "DM") return;
      
      // Check if adding these cells would exceed the limit
      const levelFog = getFogSet(msg.levelId);
      const currentSize = levelFog.size;
      const newCells = msg.cells.filter(c => !levelFog.has(cellKey(c)));
      
      if (currentSize + newCells.length > FOG_CELL_LIMIT) {
        console.warn(`[SERVER] Reveal fog rejected: would exceed limit (${currentSize + newCells.length} > ${FOG_CELL_LIMIT})`);
        return;
      }
      
      // Create snapshot before action (only captures fog state for the affected level)
      const beforeSnapshot = createFogSnapshot(msg.levelId);
      
      const added: Vec2[] = [];
      for (const c of newCells) {
        const k = cellKey(c);
        levelFog.add(k);
        added.push({ x: c.x, y: c.y });
      }
      
      if (added.length > 0) {
        const ev: Event = { type: "fogRevealed", levelId: msg.levelId, cells: added } as any;
        broadcast([ev]);
        
        // Create snapshot after action and push to undo stack
        const afterSnapshot = createFogSnapshot(msg.levelId);
        const action = createActionSnapshot(
          "revealFog",
          `Revealing fog of war (${added.length} cells)`,
          beforeSnapshot,
          afterSnapshot
        );
        pushToUndoStack(action);
        
        persistIfAutosave();
      }
      break;
    }
    case "obscureFog": {
      if (client.role !== "DM") return;
      
      // Create snapshot before action
      const beforeSnapshot = createFogSnapshot(msg.levelId);
      
      const levelFog = getFogSet(msg.levelId);
      const removed: Vec2[] = [];
      for (const c of msg.cells) {
        const k = cellKey(c);
        if (levelFog.has(k)) {
          levelFog.delete(k);
          removed.push({ x: c.x, y: c.y });
        }
      }
      if (removed.length > 0) {
        const ev: Event = { type: "fogObscured", levelId: msg.levelId, cells: removed } as any;
        broadcast([ev]);
        
        // Create snapshot after action and push to undo stack
        const afterSnapshot = createFogSnapshot(msg.levelId);
        const action = createActionSnapshot(
          "obscureFog",
          `Hiding fog of war (${removed.length} cells)`,
          beforeSnapshot,
          afterSnapshot
        );
        pushToUndoStack(action);
        
        persistIfAutosave();
      }
      break;
    }
    case "setFogMode": {
      if (client.role !== "DM") return;
      if (!state.location) return;
      
      // Create snapshot before action
      const beforeSnapshot = createGameSnapshot();
      
      state.location.fogMode = msg.fogMode;
      const ev: Event = { type: "fogModeChanged", fogMode: msg.fogMode } as any;
      broadcast([ev]);
      
      // Create snapshot after action and push to undo stack
      const afterSnapshot = createGameSnapshot();
      const action = createActionSnapshot(
        "setFogMode",
        `Changing fog mode to ${msg.fogMode === "automatic" ? "automatic" : "manual"}`,
        beforeSnapshot,
        afterSnapshot
      );
      pushToUndoStack(action);
      
      persistIfAutosave();
      break;
    }
    case "undo": {
      if (client.role !== "DM") return;
      console.log(`[SERVER] Received undo request from client ${client.id}`);
      const success = performUndo();
      if (success) {
        persistIfAutosave();
      }
      break;
    }
    case "redo": {
      if (client.role !== "DM") return;
      console.log(`[SERVER] Received redo request from client ${client.id}`);
      const success = performRedo();
      if (success) {
        persistIfAutosave();
      }
      break;
    }
    case "placeAsset": {
      if (client.role !== "DM") return;
      const gx = Math.floor(msg.pos.x);
      const gy = Math.floor(msg.pos.y);
      ensureDefaultFloorsForLevel(msg.levelId);
      if (!hasFloorAtXY(msg.levelId, gx, gy)) return;
      
      // Create snapshot before action
      const beforeState = createGameSnapshot();
      
      // remove existing asset at pos (single asset per cell policy)
      const existingId = findAssetIdAt(msg.levelId, { x: gx, y: gy });
      if (existingId) state.assets.delete(existingId);
      const asset: Asset = {
        id: "a-" + randomUUID(),
        levelId: msg.levelId,
        pos: { x: gx, y: gy },
        kind: msg.kind,
        rot: msg.rot,
        scale: msg.scale,
        tint: msg.tint,
      };
      state.assets.set(asset.id, asset);
      
      // Create snapshot after action and push to undo stack
      const afterState = createGameSnapshot();
      const action = createActionSnapshot(
        "placeAsset",
        `Placing ${msg.kind} at (${gx}, ${gy})`,
        beforeState,
        afterState
      );
      pushToUndoStack(action);
      const assetLabel = describeAsset(asset);
      const history = recordHistoryEvent(client, {
        actionType: action.actionType,
        description: `Placed ${assetLabel} at ${formatCoords({ x: gx, y: gy })}`,
        actionId: action.id,
        details: {
          targetType: "asset",
          targetId: asset.id,
          targetName: assetLabel,
          targetKind: asset.kind,
          levelId: asset.levelId,
          to: { levelId: asset.levelId, pos: { ...asset.pos } }
        }
      });
      action.historyEvents = action.historyEvents ? [...action.historyEvents, history] : [history];
      
      broadcast([{ type: "assetPlaced", asset } as any]);
      persistIfAutosave();
      break;
    }
    case "moveAsset": {
      if (client.role !== "DM") return;
      const gx = Math.floor(msg.pos.x);
      const gy = Math.floor(msg.pos.y);
      ensureDefaultFloorsForLevel(msg.levelId);
      if (!hasFloorAtXY(msg.levelId, gx, gy)) return;
      
      const asset = state.assets.get(msg.assetId);
      if (!asset) {
        console.log(`[SERVER] moveAsset rejected: asset not found`);
        break;
      }
      const previousPos: Vec2 = { x: asset.pos.x, y: asset.pos.y };
      const previousLevel = asset.levelId;
      
      // Create snapshot before action
      const beforeState = createGameSnapshot();
      
      // remove existing asset at new pos (single asset per cell policy)
      const existingId = findAssetIdAt(msg.levelId, { x: gx, y: gy });
      if (existingId && existingId !== msg.assetId) {
        state.assets.delete(existingId);
      }
      
      // update asset position
      asset.pos = { x: gx, y: gy };
      asset.levelId = msg.levelId;
      state.assets.set(asset.id, asset);
      
      // Create snapshot after action and push to undo stack
      const afterState = createGameSnapshot();
      const action = createActionSnapshot(
        "moveAsset",
        `Moving ${asset.kind} to (${gx}, ${gy})`,
        beforeState,
        afterState
      );
      pushToUndoStack(action);
      if (previousPos.x !== gx || previousPos.y !== gy || previousLevel !== asset.levelId) {
        const assetLabel = describeAsset(asset);
        const movedBetweenLevels = previousLevel !== asset.levelId;
        const description = movedBetweenLevels
          ? `Moved ${assetLabel} from ${previousLevel} ${formatCoords(previousPos)} to ${asset.levelId} ${formatCoords({ x: gx, y: gy })}`
          : `Moved ${assetLabel} from ${formatCoords(previousPos)} to ${formatCoords({ x: gx, y: gy })}`;
        recordHistoryEvent(client, {
          actionType: action.actionType,
          description,
          actionId: action.id,
          details: {
            targetType: "asset",
            targetId: asset.id,
            targetName: assetLabel,
            targetKind: asset.kind,
            levelId: asset.levelId,
            from: { levelId: previousLevel, pos: { ...previousPos } },
            to: { levelId: asset.levelId, pos: { ...asset.pos } }
          }
        });
      }
      
      broadcast([{ type: "assetUpdated", asset } as any]);
      console.log(`[SERVER] Asset ${asset.id} moved to (${gx}, ${gy})`);
      persistIfAutosave();
      break;
    }
    case "removeAssetAt": {
      if (client.role !== "DM") return;
      const gx = Math.floor(msg.pos.x);
      const gy = Math.floor(msg.pos.y);
      
      // Create snapshot before action
      const beforeState = createGameSnapshot();
      
      const removedAssets: Array<{ id: ID; kind: string; levelId: ID; pos: Vec2 }> = [];
      for (const [id, a] of state.assets.entries()) {
        if (a.levelId === msg.levelId && a.pos.x === gx && a.pos.y === gy) {
          state.assets.delete(id);
          removedAssets.push({ id, kind: a.kind, levelId: a.levelId, pos: { x: a.pos.x, y: a.pos.y } });
        }
      }
      if (removedAssets.length === 0) return;
      
      // Create snapshot after action and push to undo stack
      const afterState = createGameSnapshot();
      const action = createActionSnapshot(
        "removeAssetAt",
        `Removing objects at (${gx}, ${gy})`,
        beforeState,
        afterState
      );
      pushToUndoStack(action);
      
      const removedIds = removedAssets.map((a) => a.id);
      broadcast(removedIds.map((id) => ({ type: "assetRemoved", assetId: id } as any)));
      const firstAssetKind = removedAssets[0].kind || "asset";
      const description = removedAssets.length === 1
        ? `Removed ${firstAssetKind} at ${formatCoords({ x: gx, y: gy })}`
        : `Removed ${removedAssets.length} assets at ${formatCoords({ x: gx, y: gy })}`;
      recordHistoryEvent(client, {
        actionType: action.actionType,
        description,
        actionId: action.id,
        details: {
          targetType: "asset",
          levelId: msg.levelId,
          from: { levelId: msg.levelId, pos: { x: gx, y: gy } },
          targetId: removedAssets.length === 1 ? removedAssets[0].id : undefined,
          targetKind: removedAssets.length === 1 ? removedAssets[0].kind : undefined,
          targetName: removedAssets.length === 1 ? firstAssetKind : undefined,
          targets: removedAssets.map((a) => ({ id: a.id, kind: a.kind, name: a.kind }))
        }
      });
      persistIfAutosave();
      break;
    }
    case "removeTokenAt": {
      if (client.role !== "DM") return;
      const gx = Math.floor((msg as any).pos.x);
      const gy = Math.floor((msg as any).pos.y);
      const removedTokens: Array<{ id: ID; name: string; kind?: string; levelId: ID; pos: Vec2 }> = [];
      for (const [id, t] of state.tokens.entries()) {
        if (t.levelId === (msg as any).levelId && t.pos.x === gx && t.pos.y === gy) {
          state.tokens.delete(id);
          removedTokens.push({
            id,
            name: describeToken(t),
            kind: (t as any).kind,
            levelId: t.levelId,
            pos: { x: t.pos.x, y: t.pos.y }
          });
        }
      }
      if (removedTokens.length === 0) return;
      const removedIds = removedTokens.map((t) => t.id);
      broadcast(removedIds.map((id) => ({ type: "tokenRemoved", tokenId: id } as any)));
      const tokenList = removedTokens.map((t) => (t.name.startsWith("Token ") ? t.name : `"${t.name}"`)).join(", ");
      const description = removedTokens.length === 1
        ? `Removed ${tokenList} at ${formatCoords({ x: gx, y: gy })}`
        : `Removed ${removedTokens.length} tokens at ${formatCoords({ x: gx, y: gy })}: ${tokenList}`;
      recordHistoryEvent(client, {
        actionType: "removeTokenAt",
        description,
        details: {
          targetType: "token",
          targetId: removedTokens.length === 1 ? removedTokens[0].id : undefined,
          targetName: removedTokens.length === 1 ? removedTokens[0].name : undefined,
          targetKind: removedTokens.length === 1 ? removedTokens[0].kind : undefined,
          levelId: (msg as any).levelId,
          from: { levelId: (msg as any).levelId, pos: { x: gx, y: gy } },
          targets: removedTokens.map((t) => ({ id: t.id, name: t.name, kind: t.kind }))
        }
      });
      persistIfAutosave();
      break;
    }
    case "toggleDoor": {
      // Allow both DM and players to toggle doors
      const a = state.assets.get(msg.assetId);
      if (!a) return;
      if (a.kind !== "door" && !a.kind.startsWith("door-")) return;
      a.open = !(a.open === true);
      state.assets.set(a.id, a);
      broadcast([{ type: "assetPlaced", asset: a } as any]);
      persistIfAutosave();
      break;
    }
    case "paintFloor": {
      if (client.role !== "DM") return;
      const gx = Math.floor(msg.pos.x);
      const gy = Math.floor(msg.pos.y);
      
      // Create snapshot before action
      const beforeState = createGameSnapshot();
      
      const key = cellKey({ x: gx, y: gy });
      let level = state.floors.get(msg.levelId);
      if (!level) { level = new Map(); state.floors.set(msg.levelId, level); }
      if (msg.kind == null) {
        level.delete(key);
      } else {
        level.set(key, msg.kind);
      }
      
      // Create snapshot after action and push to undo stack
      const afterState = createGameSnapshot();
      const action = createActionSnapshot(
        "paintFloor",
        `Painting floor at (${gx}, ${gy})`,
        beforeState,
        afterState
      );
      pushToUndoStack(action);
      
      const ev: Event = { type: "floorPainted", levelId: msg.levelId, pos: { x: gx, y: gy }, kind: msg.kind } as any;
      broadcast([ev]);
      persistIfAutosave();
      break;
    }
    case "requestSave": {
      // anyone can request their own save snapshot; typically DM
      const { snapshot: snap } = snapshot();
      send(client.socket, { t: "saveData", snapshot: snap } as any);
      break;
    }
    case "loadSnapshot": {
      if (client.role !== "DM") return;
      const snap = msg.snapshot;
      applySnapshot(snap);
      
      // Clear undo/redo history when loading new snapshot
      clearUndoRedoHistory();
      
      (async () => {
        try {
          await ensureDataRoot();
          currentSavePath = null; // not yet saved to a file
          await writeLastUsed(""); // clear last used until explicit save
        } catch {}
        // broadcast reset to all clients
        for (const c of state.clients.values()) send(c.socket, { t: "reset", snapshot: snap } as any);
        // refresh locations tree for the initiating client
        try {
          const tree = await buildLocationsTree();
          const lastUsedPath = await tryReadLastUsed();
          try {
            const exists = (nodes: LocationTreeNode[]): boolean => {
              for (const n of nodes) {
                const nn: any = n as any;
                if (nn.type === "file") {
                  const p = String(nn.path || "").toLowerCase();
                  if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
                }
                if (Array.isArray(nn.children) && nn.children.length) {
                  if (exists(nn.children)) return true;
                }
              }
              return false;
            };
            const hasDemo = exists(tree);
            console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
          } catch {}
          send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
        } catch {}
      })();
      break;
    }
    case "loadLocation": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        const rel = msg.path.endsWith(".json") ? msg.path : msg.path + ".json";
        const safe = withinDataRoot(rel);
        if (!safe) return send(client.socket, { t: "error", message: "Invalid path" });
        try {
          const snap = await readJSON<GameSnapshot>(safe);
          applySnapshot(snap);
          currentSavePath = rel;
          await writeLastUsed(rel);
          // broadcast reset to all clients
          for (const c of state.clients.values()) send(c.socket, { t: "reset", snapshot: snap } as any);
          // refresh locations list for the requester
          const tree = await buildLocationsTree();
          const lastUsedPath = await tryReadLastUsed();
          try {
            const exists = (nodes: LocationTreeNode[]): boolean => {
              for (const n of nodes) {
                const nn: any = n as any;
                if (nn.type === "file") {
                  const p = String(nn.path || "").toLowerCase();
                  if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
                }
                if (Array.isArray(nn.children) && nn.children.length) {
                  if (exists(nn.children)) return true;
                }
              }
              return false;
            };
            const hasDemo = exists(tree);
            console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
          } catch {}
          send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
        } catch {
          send(client.socket, { t: "error", message: "Failed to load location" } as any);
        }
      })();
      break;
    }
    case "listLocations": {
      (async () => {
        await ensureDataRoot();
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
        try {
          const exists = (nodes: LocationTreeNode[]): boolean => {
            for (const n of nodes) {
              const nn: any = n as any;
              if (nn.type === "file") {
                const p = String(nn.path || "").toLowerCase();
                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
              }
              if (Array.isArray(nn.children) && nn.children.length) {
                if (exists(nn.children)) return true;
              }
            }
            return false;
          };
          const hasDemo = exists(tree);
          console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
      })();
      break;
    }
    case "saveLocation": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        const rel = msg.path.endsWith(".json") ? msg.path : msg.path + ".json";
        const safe = withinDataRoot(rel);
        if (!safe) return send(client.socket, { t: "error", message: "Invalid path" });
        const { snapshot: snap } = snapshot();
        await writeJSON(safe, snap);
        await writeLastUsed(rel);
        currentSavePath = rel;
        send(client.socket, { t: "savedOk", path: rel } as any);
        // optionally refresh list
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
        try {
          const exists = (nodes: LocationTreeNode[]): boolean => {
            for (const n of nodes) {
              const nn: any = n as any;
              if (nn.type === "file") {
                const p = String(nn.path || "").toLowerCase();
                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
              }
              if (Array.isArray(nn.children) && nn.children.length) {
                if (exists(nn.children)) return true;
              }
            }
            return false;
          };
          const hasDemo = exists(tree);
          console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
      })();
      break;
    }
    case "createFolder": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        const rel = msg.path.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
        const dirAbs = withinDataRoot(path.join(rel, path.sep));
        if (!dirAbs) return send(client.socket, { t: "error", message: "Invalid folder path" });
        await fs.mkdir(dirAbs, { recursive: true });
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
        try {
          const exists = (nodes: LocationTreeNode[]): boolean => {
            for (const n of nodes) {
              const nn: any = n as any;
              if (nn.type === "file") {
                const p = String(nn.path || "").toLowerCase();
                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
              }
              if (Array.isArray(nn.children) && nn.children.length) {
                if (exists(nn.children)) return true;
              }
            }
            return false;
          };
          const hasDemo = exists(tree);
          console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
      })();
      break;
    }
    case "deleteLocation": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        const rel = msg.path;
        const safe = withinDataRoot(rel);
        if (!safe) return send(client.socket, { t: "error", message: "Invalid path" });
        try {
          await fs.unlink(safe);
          if (currentSavePath === rel) currentSavePath = null;
          const last = await tryReadLastUsed();
          if (last === rel) await writeLastUsed("");
        } catch {
          // ignore
        }
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
        try {
          const exists = (nodes: LocationTreeNode[]): boolean => {
            for (const n of nodes) {
              const nn: any = n as any;
              if (nn.type === "file") {
                const p = String(nn.path || "").toLowerCase();
                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
              }
              if (Array.isArray(nn.children) && nn.children.length) {
                if (exists(nn.children)) return true;
              }
            }
            return false;
          };
          const hasDemo = exists(tree);
          console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
      })();
      break;
    }
    case "moveLocation": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        const fromRel = msg.from;
        const toFolderRel = msg.toFolder.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
        const fromAbs = withinDataRoot(fromRel);
        const toDirAbs = toFolderRel === "" ? DATA_ROOT : withinDataRoot(path.join(toFolderRel, path.sep));
        if (!fromAbs || !toDirAbs) return send(client.socket, { t: "error", message: "Invalid path" });
        await fs.mkdir(toDirAbs, { recursive: true });
        const base = path.basename(fromRel);
        const toRel = path.join(toFolderRel, base);
        const toAbs = withinDataRoot(toRel)!;
        try {
          await fs.rename(fromAbs, toAbs);
          if (currentSavePath === fromRel) {
            currentSavePath = toRel;
            await writeLastUsed(toRel);
          }
        } catch (e) {
          send(client.socket, { t: "error", message: "Failed to move location" });
        }
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
        try {
          const exists = (nodes: LocationTreeNode[]): boolean => {
            for (const n of nodes) {
              const nn: any = n as any;
              if (nn.type === "file") {
                const p = String(nn.path || "").toLowerCase();
                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
              }
              if (Array.isArray(nn.children) && nn.children.length) {
                if (exists(nn.children)) return true;
              }
            }
            return false;
          };
          const hasDemo = exists(tree);
          console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
      })();
      break;
    }
    case "renameFolder": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        // sanitize inputs
        const rel = String(msg.path || "").replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
        const newName = String(msg.newName || "").replace(/\s+/g, " ").trim();
        if (!rel) return send(client.socket, { t: "error", message: "Invalid folder path" });
        if (!newName || /[\\/]/.test(newName)) return send(client.socket, { t: "error", message: "Invalid new name" });
        const fromAbs = withinDataRoot(rel);
        if (!fromAbs) return send(client.socket, { t: "error", message: "Invalid folder path" });
        // ensure target exists and is a directory
        try {
          const st = await fs.stat(fromAbs);
          if (!st.isDirectory()) return send(client.socket, { t: "error", message: "Not a folder" });
        } catch {
          return send(client.socket, { t: "error", message: "Folder not found" });
        }
        const parentRel = path.dirname(rel);
        const toRel = parentRel === "." ? newName : path.join(parentRel, newName);
        const toAbs = withinDataRoot(toRel);
        if (!toAbs) return send(client.socket, { t: "error", message: "Invalid rename target" });
        try {
          await fs.rename(fromAbs, toAbs);
          // update currentSavePath and last-used if they reside under renamed directory
          if (currentSavePath && (currentSavePath === rel || currentSavePath.startsWith(rel + "/"))) {
            const updated = currentSavePath.replace(rel, toRel);
            currentSavePath = updated;
            try { await writeLastUsed(updated); } catch {}
          }
        } catch (e) {
          return send(client.socket, { t: "error", message: "Failed to rename folder" });
        }
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
        try {
          const exists = (nodes: LocationTreeNode[]): boolean => {
            for (const n of nodes) {
              const nn: any = n as any;
              if (nn.type === "file") {
                const p = String(nn.path || "").toLowerCase();
                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
              }
              if (Array.isArray(nn.children) && nn.children.length) {
                if (exists(nn.children)) return true;
              }
            }
            return false;
          };
          const hasDemo = exists(tree);
          console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
      })();
      break;
    }
    case "renameLocation": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        const newName = String(msg.newName || "").replace(/\s+/g, " ").trim();
        if (!newName) return send(client.socket, { t: "error", message: "Invalid location name" });
        
        // Update current location name
        if (state.location) {
          state.location.name = newName;
          
          // Save the updated location
          if (currentSavePath) {
            try {
              const snap = createGameSnapshot();
              const fileAbs = withinDataRoot(currentSavePath);
              if (fileAbs) {
                await writeJSON(fileAbs, snap);
                console.log(`[server] renamed location to: ${newName}`);
              }
            } catch (e) {
              console.error("[server] failed to save renamed location:", e);
              return send(client.socket, { t: "error", message: "Failed to save location" });
            }
          }
          
          // Broadcast the name change to all clients
          const broadcastMsg: ServerToClient = { t: "locationRenamed", newName };
          for (const c of state.clients.values()) {
            send(c.socket, broadcastMsg);
          }
        }
      })();
      break;
    }
    case "loadLocationById": {
      // Allow any client to load a location by ID
      (async () => {
        await ensureDataRoot();
        const locationId = (msg as any).locationId;
        if (!locationId) return send(client.socket, { t: "error", message: "Location ID required" });
        
        // Find location file by ID
        const tree = await buildLocationsTree();
        let locationPath: string | null = null;
        
        const findLocation = async (nodes: LocationTreeNode[]): Promise<boolean> => {
          for (const node of nodes) {
            if (node.type === "file") {
              // Check if this file contains the location ID
              const filePath = node.path;
              const safe = withinDataRoot(filePath);
              if (safe) {
                try {
                  const snap = await readJSON<GameSnapshot>(safe);
                  if (snap.location?.id === locationId) {
                    locationPath = filePath;
                    return true;
                  }
                } catch (e) {
                  // Continue searching
                }
              }
            }
            if (node.children && await findLocation(node.children)) {
              return true;
            }
          }
          return false;
        };
        
        if (!(await findLocation(tree)) || !locationPath) {
          return send(client.socket, { t: "error", message: "Location not found" });
        }
        
        const safe = withinDataRoot(locationPath);
        if (!safe) return send(client.socket, { t: "error", message: "Invalid path" });
        
        try {
          const snap = await readJSON<GameSnapshot>(safe);
          applySnapshot(snap);
          currentSavePath = locationPath;
          await writeLastUsed(locationPath);
          // broadcast reset to all clients
          for (const c of state.clients.values()) send(c.socket, { t: "reset", snapshot: snap } as any);
          send(client.socket, { t: "savedOk", path: locationPath });
        } catch (e) {
          send(client.socket, { t: "error", message: "Failed to load location" });
        }
      })();
      break;
    }
    case "toggleTokenHidden": {
      if (client.role !== "DM") {
        console.log(`[SERVER] toggleTokenHidden rejected: not DM`);
        break;
      }
      const token = state.tokens.get(msg.tokenId);
      if (!token) {
        console.log(`[SERVER] toggleTokenHidden rejected: token not found`);
        break;
      }
      // Toggle hidden state
      (token as any).hidden = !(token as any).hidden;
      state.tokens.set(token.id, token);
      broadcast([{ type: "tokenUpdated", token } as any]);
      console.log(`[SERVER] Token ${token.id} hidden state toggled to ${(token as any).hidden}`);
      persistIfAutosave();
      break;
    }
    case "toggleAssetHidden": {
      if (client.role !== "DM") {
        console.log(`[SERVER] toggleAssetHidden rejected: not DM`);
        break;
      }
      console.log(`[SERVER] toggleAssetHidden: looking for assetId=${msg.assetId}`);
      console.log(`[SERVER] Available asset IDs:`, Array.from(state.assets.keys()).slice(0, 10));
      const asset = state.assets.get(msg.assetId);
      if (!asset) {
        console.log(`[SERVER] toggleAssetHidden rejected: asset not found`);
        break;
      }
      // Toggle hidden state
      (asset as any).hidden = !(asset as any).hidden;
      state.assets.set(asset.id, asset);
      broadcast([{ type: "assetUpdated", asset } as any]);
      console.log(`[SERVER] Asset ${asset.id} hidden state toggled to ${(asset as any).hidden}`);
      persistIfAutosave();
      break;
    }
    case "switchRole": {
      // Allow role switching for any client
      const newRole = (msg as any).role;
      if (newRole === "DM" || newRole === "PLAYER") {
        const prevRole = client.role;
        client.role = newRole;
        send(client.socket, { t: "roleChanged", role: newRole });
        console.log(`[SERVER] Client ${client.id} switched role to ${newRole}`);
        if (client.role === "DM" && prevRole !== "DM") {
          sendHistorySnapshot(client);
        }
      }
      break;
    }
    case "login": {
      const loginData = (msg as any).data;
      userManager.login(loginData).then(result => {
        if (result.success && result.user && result.token) {
          client.user = result.user;
          client.token = result.token;
          // Set role based on user role
          client.role = result.user.role === 'master' ? 'DM' : 'PLAYER';
          send(client.socket, { t: "loginResponse", success: true, user: result.user, token: result.token });
          console.log(`[SERVER] User ${result.user.username} logged in successfully`);
          if (client.role === "DM") {
            sendHistorySnapshot(client);
          }
        } else {
          send(client.socket, { t: "loginResponse", success: false, error: result.error });
        }
      });
      break;
    }
    case "createFirstUser": {
      if (!userManager.needsFirstUser()) {
        send(client.socket, { t: "createFirstUserResponse", success: false, error: "First user already exists" });
        return;
      }
      const userData = (msg as any).data;
      userManager.createFirstUser(userData).then(result => {
        send(client.socket, { t: "createFirstUserResponse", success: result.success, user: result.user, generatedPassword: result.generatedPassword, error: result.error });
        if (result.success) {
          console.log(`[SERVER] First user ${result.user?.username} created successfully`);
        }
      });
      break;
    }
    case "checkFirstUser": {
      const needsFirstUser = userManager.needsFirstUser();
      console.log(`[SERVER] checkFirstUser: needsFirstUser=${needsFirstUser}, total users=${userManager.getAllUsers().length}`);
      send(client.socket, { t: "firstUserCheckResponse", needsFirstUser });
      break;
    }
    case "resumeSession": {
      const token = (msg as any).token;
      if (!token || typeof token !== "string") {
        send(client.socket, { t: "resumeSessionResponse", success: false, error: "Invalid session token" });
        break;
      }
      const user = userManager.getUserByToken(token);
      if (!user) {
        send(client.socket, { t: "resumeSessionResponse", success: false, error: "Session expired" });
        break;
      }
      client.user = user;
      client.token = token;
      client.role = user.role === "master" ? "DM" : "PLAYER";
      send(client.socket, { t: "resumeSessionResponse", success: true, user, token });
      console.log(`[SERVER] Client ${client.id} resumed session as ${user.username}`);
      break;
    }
    case "logout": {
      if (client.token) {
        userManager.logout(client.token);
        client.user = undefined;
        client.token = undefined;
        send(client.socket, { t: "logoutResponse", success: true });
        console.log(`[SERVER] Client ${client.id} logged out`);
      }
      break;
    }
    case "createUser": {
      if (!client.user || !userManager.isMasterUser(client.user.id)) {
        send(client.socket, { t: "createUserResponse", success: false, error: "Access denied" });
        return;
      }
      const userData = (msg as any).data;
      userManager.createUser(userData).then(result => {
        send(client.socket, { t: "createUserResponse", success: result.success, user: result.user, generatedPassword: result.generatedPassword, error: result.error });
        if (result.success) {
          console.log(`[SERVER] User ${result.user?.username} created by ${client.user?.username}`);
        }
      });
      break;
    }
    case "listUsers": {
      if (!client.user || !userManager.isMasterUser(client.user.id)) {
        send(client.socket, { t: "userListResponse", users: [] });
        return;
      }
      const users = userManager.getAllUsers();
      send(client.socket, { t: "userListResponse", users });
      break;
    }
    case "updateUserRole": {
      if (!client.user || !userManager.isMasterUser(client.user.id)) {
        send(client.socket, { t: "updateUserRoleResponse", success: false, error: "Access denied" });
        return;
      }
      const { userId, role } = msg as any;
      if (typeof userId !== "string" || (role !== "master" && role !== "user")) {
        send(client.socket, { t: "updateUserRoleResponse", success: false, error: "Invalid payload" });
        return;
      }
      if (client.user.id === userId) {
        send(client.socket, { t: "updateUserRoleResponse", success: false, error: "You cannot change your own role" });
        return;
      }
      const success = userManager.updateUserRole(userId, role);
      send(client.socket, { t: "updateUserRoleResponse", success, error: success ? undefined : "Failed to update user role" });
      break;
    }
    case "deleteUser": {
      if (!client.user || !userManager.isMasterUser(client.user.id)) {
        send(client.socket, { t: "deleteUserResponse", success: false, error: "Access denied" });
        return;
      }
      const { userId } = msg as any;
      const success = userManager.deleteUser(userId);
      send(client.socket, { t: "deleteUserResponse", success, error: success ? undefined : "Failed to delete user" });
      break;
    }
    case "resetUserPassword": {
      if (!client.user || !userManager.isMasterUser(client.user.id)) {
        send(client.socket, { t: "resetUserPasswordResponse", success: false, error: "Access denied" });
        return;
      }
      const { userId, password } = msg as any;
      if (typeof userId !== "string") {
        send(client.socket, { t: "resetUserPasswordResponse", success: false, error: "Invalid payload" });
        return;
      }
      userManager.resetUserPassword(userId, typeof password === "string" ? password : undefined)
        .then((result) => {
          if (result.success) {
            send(client.socket, { t: "resetUserPasswordResponse", success: true, userId, generatedPassword: result.generatedPassword });
            console.log(`[SERVER] Password reset for user ${userId} by ${client.user?.username}`);
          } else {
            send(client.socket, { t: "resetUserPasswordResponse", success: false, error: "Failed to reset password" });
          }
        })
        .catch((error) => {
          console.error("[SERVER] resetUserPassword failed:", error);
          send(client.socket, { t: "resetUserPasswordResponse", success: false, error: "Failed to reset password" });
      });
      break;
    }
    case "changeOwnPassword": {
      if (!client.user) {
        send(client.socket, { t: "changePasswordResponse", success: false, error: "Not authenticated" });
        break;
      }
      const payload = (msg as any).data ?? {};
      const currentPassword = typeof payload.currentPassword === "string" ? payload.currentPassword : "";
      const newPassword = typeof payload.newPassword === "string" ? payload.newPassword : "";
      userManager.changePassword(client.user.id, currentPassword, newPassword)
        .then((result) => {
          if (!result.success) {
            send(client.socket, { t: "changePasswordResponse", success: false, error: result.error ?? "Failed to change password" });
            return;
          }
          if (client.token) {
            userManager.logout(client.token);
          }
          client.user = undefined;
          client.token = undefined;
          client.role = "PLAYER";
          send(client.socket, {
            t: "changePasswordResponse",
            success: true,
            forceLogout: true,
            message: "Password updated. Please log in again."
          });
        })
        .catch((error) => {
          console.error("[SERVER] changeOwnPassword failed:", error);
          send(client.socket, { t: "changePasswordResponse", success: false, error: "Failed to change password" });
        });
      break;
    }
  }
}

function cellKey(v: Vec2): string { return `${v.x},${v.y}`; }
function getFogSet(levelId: ID): Set<string> {
  let s = state.fog.get(levelId);
  if (!s) { s = new Set(); state.fog.set(levelId, s); }
  return s;
}

function cellsInRadius(center: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  const R = Math.max(0, Math.min(20, Math.round(r || 0)));
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dy * dy <= R * R) out.push({ x: center.x + dx, y: center.y + dy });
    }
  }
  return out;
}

function findAssetIdAt(levelId: ID, pos: Vec2): ID | null {
  for (const [id, a] of state.assets.entries()) {
    if (a.levelId === levelId && a.pos.x === pos.x && a.pos.y === pos.y) return id;
  }
  return null;
}

function hasFloorAt(levelId: ID, pos: Vec2): boolean {
  const m = state.floors.get(levelId);
  if (!m) return false;
  return m.has(`${pos.x},${pos.y}`);
}

function hasFloorAtXY(levelId: ID, x: number, y: number): boolean {
  const m = state.floors.get(levelId);
  if (!m) return false;
  return m.has(`${x},${y}`);
}

// Generate a bright-ish random color (each channel in [128..255])
function randomBrightColor(): number {
  const ch = () => (128 + Math.floor(Math.random() * 128)) & 0xff;
  return (ch() << 16) | (ch() << 8) | ch();
}

// Available character icons
const SHARED_CHARACTER_ICONS = [
  "🧙", "🧙‍♂️", "🧙‍♀️", "🧝", "🧝‍♂️", "🧝‍♀️", "🧛", "🧛‍♂️", "🧛‍♀️",
  "🧚", "🧚‍♂️", "🧚‍♀️", "🧞", "🧞‍♂️", "🧞‍♀️", "🧜", "🧜‍♂️", "🧜‍♀️",
  "🧟", "🧟‍♂️", "🧟‍♀️", "🧌", "🥷", "🤺", "🦸", "🦸‍♂️", "🦸‍♀️",
  "🦹", "🦹‍♂️", "🦹‍♀️", "🤴", "👸", "🐺", "🐻", "🦁", "🐯", "🐗",
  "🐴", "🐉", "🐲", "🦅", "🦉", "🦇", "🦊"
];

const CHARACTER_ICONS = {
  players: [...SHARED_CHARACTER_ICONS],
  npcs: [...SHARED_CHARACTER_ICONS]
};

function getRandomIcon(kind: "player" | "npc"): string {
  const icons = CHARACTER_ICONS[kind === "npc" ? "npcs" : "players"];
  return icons[Math.floor(Math.random() * icons.length)];
}

function makePlayerToken(playerId: ID, levelId: ID, spawn: Vec2): Token {
  return {
    id: "t-" + randomUUID(),
    owner: playerId,
    kind: "player",
    levelId,
    pos: { ...spawn },
    vision: { radius: 8, angle: 360 },
    light: null,
    flags: {},
    name: "Player",
    tint: randomBrightColor(),
    zIndex: 100, // Default above assets
    hp: 1,
    ac: 0,
    stats: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0, hp: 1, ac: 0 },
    icon: getRandomIcon("player"),
  } as any;
}

function makeNPCToken(owner: ID, levelId: ID, spawn: Vec2): Token {
  return {
    id: "t-" + randomUUID(),
    owner,
    kind: "npc",
    levelId,
    pos: { ...spawn },
    vision: { radius: 8, angle: 360 },
    light: null,
    flags: {},
    name: "NPC",
    tint: randomBrightColor(),
    zIndex: 100, // Default above assets
    hp: 1,
    ac: 0,
    stats: { str: 0, dex: 0, con: 0, int: 0, wis: 0, cha: 0, hp: 1, ac: 0 },
    icon: getRandomIcon("npc"),
  } as any;
}

function formatCoords(pos: Vec2): string {
  return `(${Math.round(pos.x)}, ${Math.round(pos.y)})`;
}

function describeToken(token: Token): string {
  const name = token.name && token.name.trim().length > 0 ? token.name.trim() : null;
  return name ? `${name}` : `Token ${token.id}`;
}

function describeAsset(asset: Asset): string {
  const kind = asset.kind || "asset";
  return `${kind}`;
}

function snapshot(): { snapshot: { location: Location; tokens: Token[]; assets: Asset[]; events: Event[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[]; history: HistoryEvent[] } } {
  ensureDefaultFloorsForAllLevels();
  const events: Event[] = [];
  console.log(`[SERVER] Creating snapshot, fog levels: ${state.fog.size}`);
  for (const [lvl, set] of state.fog.entries()) {
    const cells = Array.from(set).map((k) => {
      const [xs, ys] = k.split(",");
      return { x: Number(xs), y: Number(ys) } as Vec2;
    });
    console.log(`[SERVER] Saving fog for level ${lvl}, ${cells.length} cells`);
    if (cells.length > 0) events.push({ type: "fogRevealed", levelId: lvl, cells } as any);
  }
  // floors as entries for client bootstrap
  const floorsArr: { levelId: ID; pos: Vec2; kind: FloorKind }[] = [];
  for (const [lvl, mp] of state.floors.entries()) {
    for (const [k, kind] of mp.entries()) {
      const [xs, ys] = k.split(",");
      floorsArr.push({ levelId: lvl, pos: { x: Number(xs), y: Number(ys) }, kind });
    }
  }
  return {
    snapshot: {
      location: deepCopy(state.location),
      tokens: Array.from(state.tokens.values()).map((tok) => deepCopy(tok)),
      assets: Array.from(state.assets.values()).map((asset) => deepCopy(asset)),
      events,
      floors: floorsArr,
      history: state.history.map(ev => deepCopy(ev))
    }
  };
}

function onConnection(ws: import("ws").WebSocket, req: IncomingMessage) {
  // Check client limit
  if (state.clients.size >= MAX_CLIENTS) {
    console.warn(`[SERVER] Client limit reached (${MAX_CLIENTS}), rejecting connection`);
    ws.close(1013, "Server overloaded");
    return;
  }

  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const invite = url.searchParams.get("inv");
  const role = roleFromInvite(invite);
  const clientId = "p-" + randomUUID();
  const client: ClientRec = { id: clientId, role, socket: ws };
  state.clients.set(clientId, client);
  
  console.log(`[SERVER] Client ${clientId} connected (${state.clients.size}/${MAX_CLIENTS} clients)`);

  const levelId = state.location.levels[0].id;
  const spawn = state.location.levels[0].spawnPoint;
  // Do NOT auto-spawn tokens on connect. Tokens are added explicitly via 'spawnToken'.
  // Ensure fog set exists for default level
  getFogSet(levelId);

  // Send welcome with snapshot
  const snap = snapshot();
  console.log(`[SERVER] Sending welcome to ${clientId}, role=${role}, assets count=${snap.snapshot.assets.length}`);
  console.log(`[SERVER] First 5 asset IDs in snapshot:`, snap.snapshot.assets.slice(0, 5).map(a => a.id));
  send(ws, { t: "welcome", playerId: clientId, role, ...snap, history: role === "DM" ? state.history : undefined });
  
  // Send initial undo/redo state
  send(ws, { 
    t: "undoRedoState", 
    undoStack: state.undoRedo.undoStack, 
    redoStack: state.undoRedo.redoStack 
  });

  ws.on("message", (data: import("ws").RawData) => onMessage(client, data));
  ws.on("close", () => {
    console.log(`[SERVER] Client ${clientId} disconnected`);
    state.clients.delete(clientId);
  });
  ws.on("error", (error) => {
    console.error(`[SERVER] WebSocket error for client ${clientId}:`, error);
    state.clients.delete(clientId);
  });
}

async function start() {
  await ensureDataRoot();
  // Log resolved data root for diagnostics
  try { console.log(`[server] DATA_ROOT: ${DATA_ROOT}`); } catch {}
  
  // Start memory monitoring
  setInterval(checkMemoryAndCleanup, 30000); // Check every 30 seconds
  console.log(`[server] Memory monitoring enabled (max: ${MAX_MEMORY_MB}MB, fog limit: ${FOG_CELL_LIMIT})`);
  
  // Autoload last used location if present
  try {
    const rel = await tryReadLastUsed();
    if (rel) {
      const safe = withinDataRoot(rel);
      if (safe) {
        const snap = await readJSON<GameSnapshot>(safe);
        applySnapshot(snap);
        console.log(`[server] autoloaded location: ${rel}`);
      }
    }
  } catch (e) {
    console.warn("[server] autoload skipped:", e);
  }
  const server: HTTPServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("DnD Server is running\n");
  });
  // Port listen with retry: if in use, increment port until a free one is found (bounded range)
  let selectedPort = PORT;
  const maxPort = Number(process.env.MAX_PORT || (PORT + 20));
  let attempts = 0;
  while (true) {
    attempts++;
    try {
      try { console.log(`[server] attempting to listen on http://localhost:${selectedPort} (attempt ${attempts})`); } catch {}
      await new Promise<void>((resolve, reject) => {
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        const onError = (err: any) => {
          server.off("listening", onListening);
          reject(err);
        };
        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(selectedPort);
      });
      break; // success
    } catch (err: any) {
      if (err && err.code === "EADDRINUSE") {
        try { console.warn(`[server] port ${selectedPort} is in use, trying next...`); } catch {}
        selectedPort++;
        if (selectedPort > maxPort) {
          throw new Error(`[server] No free port found in range ${PORT}-${maxPort}`);
        }
        continue;
      }
      throw err; // other errors
    }
  }
  // Only create WebSocket server once HTTP server is bound successfully
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", onConnection);
  wss.on("error", (err) => {
    try { console.warn(`[server][wss] error: ${String((err as any)?.message || err)}`); } catch {}
  });
  console.log(`[server] listening on http://localhost:${selectedPort}`);
}

start();
