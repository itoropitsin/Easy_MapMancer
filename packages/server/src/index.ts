import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { Server as HTTPServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import type { ServerToClient, ClientToServer, Location, Level, Token, Vec2, Role, ID, Event, Asset, FloorKind, LocationTreeNode, GameSnapshot } from "@dnd/shared";

const PORT = Number(process.env.PORT || 8080);
const DATA_ROOT = process.env.LOCATIONS_DIR || path.resolve(process.cwd(), "data/locations");
const LAST_USED_FILE = path.resolve(DATA_ROOT, "last-used.json");

// Simple in-memory state
interface ClientRec {
  id: ID;
  role: Role;
  socket: import("ws").WebSocket;
}

function applySnapshot(snap: GameSnapshot) {
  // replace state
  state.location = snap.location;
  state.tokens.clear();
  for (const t of snap.tokens) state.tokens.set(t.id, t);
  state.assets.clear();
  for (const a of snap.assets) state.assets.set(a.id, a);
  state.fog.clear();
  // rebuild fog from snapshot events if present
  if (Array.isArray(snap.events)) {
    for (const e of snap.events) {
      if ((e as any).type === "fogRevealed") {
        const s = getFogSet((e as any).levelId);
        for (const c of (e as any).cells) s.add(cellKey(c));
      }
    }
  }
  state.floors.clear();
  if (Array.isArray(snap.floors)) {
    for (const f of snap.floors) {
      let m = state.floors.get(f.levelId);
      if (!m) { m = new Map(); state.floors.set(f.levelId, m); }
      m.set(`${f.pos.x},${f.pos.y}`, f.kind);
    }
  }
}

interface GameState {
  location: Location;
  tokens: Map<ID, Token>;
  clients: Map<ID, ClientRec>;
  fog: Map<ID, Set<string>>; // levelId -> set of "x,y"
  assets: Map<ID, Asset>;
  floors: Map<ID, Map<string, FloorKind>>; // levelId -> ("x,y" -> kind)
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

const state: GameState = {
  location: makeDefaultLocation(),
  tokens: new Map(),
  clients: new Map(),
  fog: new Map(),
  assets: new Map(),
  floors: new Map(),
};

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
  const buf = await fs.readFile(file, "utf8");
  return JSON.parse(buf) as T;
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
        const rel = path.join(dirRel, ent.name);
        const fileAbs = withinDataRoot(rel)!;
        let locationName: string | undefined;
        try {
          const snap = await readJSON<GameSnapshot>(fileAbs);
          locationName = snap?.location?.name;
        } catch {}
        files.push({ type: "file", name: ent.name.replace(/\.json$/i, ""), path: rel, locationName });
      }
    }
    folders.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    files.sort((a, b) => a.name.localeCompare(b.name, "ru"));
    return [...folders, ...files];
  }
  return walk("");
}

function roleFromInvite(inv?: string | null): Role {
  if (!inv) return "PLAYER";
  if (inv.startsWith("dm-")) return "DM";
  return "PLAYER";
}

function send(ws: import("ws").WebSocket, msg: ServerToClient) {
  ws.send(JSON.stringify(msg));
}

function broadcast(events: Event[]) {
  for (const c of state.clients.values()) {
    send(c.socket, { t: "statePatch", events });
  }
}

function onMessage(client: ClientRec, data: any) {
  let msg: ClientToServer | undefined;
  try {
    msg = JSON.parse(String(data));
  } catch (e) {
    return send(client.socket, { t: "error", message: "Invalid JSON" });
  }

  if (!msg || typeof msg !== "object" || !("t" in msg)) return;

  switch (msg.t) {
    case "moveToken": {
      const tok = state.tokens.get(msg.tokenId);
      if (!tok) return;
      if (client.role !== "DM" && tok.owner !== client.id) return;
      // Keep inside 10x10 island and only on land
      const pos = clampVec(msg.pos, { x: 0, y: 0 }, { x: 9, y: 9 });
      // allow moving onto natural land OR painted floor override
      const hasFloor = (() => {
        const m = state.floors.get(msg.levelId);
        if (!m) return false;
        return m.has(`${pos.x},${pos.y}`);
      })();
      if (!isLand(pos.x, pos.y) && !hasFloor) return;
      tok.pos = pos;
      tok.levelId = msg.levelId;
      const ev: Event = { type: "tokenMoved", tokenId: tok.id, pos, levelId: tok.levelId };
      broadcast([ev]);
      break;
    }
    case "revealFog": {
      if (client.role !== "DM") return;
      const levelFog = getFogSet(msg.levelId);
      const added: Vec2[] = [];
      for (const c of msg.cells) {
        const k = cellKey(c);
        if (!levelFog.has(k)) {
          levelFog.add(k);
          added.push({ x: c.x, y: c.y });
        }
      }
      if (added.length > 0) {
        const ev: Event = { type: "fogRevealed", levelId: msg.levelId, cells: added } as any;
        broadcast([ev]);
      }
      break;
    }
    case "obscureFog": {
      if (client.role !== "DM") return;
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
      }
      break;
    }
    case "placeAsset": {
      if (client.role !== "DM") return;
      const gx = Math.floor(msg.pos.x);
      const gy = Math.floor(msg.pos.y);
      // allow placing on natural land OR on painted floor override
      const hasFloor = (() => {
        const m = state.floors.get(msg.levelId);
        if (!m) return false;
        return m.has(`${gx},${gy}`);
      })();
      if (!isLand(gx, gy) && !hasFloor) return;
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
      broadcast([{ type: "assetPlaced", asset } as any]);
      break;
    }
    case "removeAssetAt": {
      if (client.role !== "DM") return;
      const gx = Math.floor(msg.pos.x);
      const gy = Math.floor(msg.pos.y);
      const removed: ID[] = [];
      for (const [id, a] of state.assets.entries()) {
        if (a.levelId === msg.levelId && a.pos.x === gx && a.pos.y === gy) {
          state.assets.delete(id);
          removed.push(id);
        }
      }
      if (removed.length === 0) return;
      broadcast(removed.map((id) => ({ type: "assetRemoved", assetId: id } as any)));
      break;
    }
    case "toggleDoor": {
      // Allow both DM and players to toggle doors
      const a = state.assets.get(msg.assetId);
      if (!a) return;
      if (a.kind !== "door") return;
      a.open = !(a.open === true);
      state.assets.set(a.id, a);
      broadcast([{ type: "assetPlaced", asset: a } as any]);
      break;
    }
    case "paintFloor": {
      if (client.role !== "DM") return;
      const gx = Math.floor(msg.pos.x);
      const gy = Math.floor(msg.pos.y);
      const key = cellKey({ x: gx, y: gy });
      let level = state.floors.get(msg.levelId);
      if (!level) { level = new Map(); state.floors.set(msg.levelId, level); }
      if (msg.kind == null) {
        level.delete(key);
      } else {
        level.set(key, msg.kind);
      }
      const ev: Event = { type: "floorPainted", levelId: msg.levelId, pos: { x: gx, y: gy }, kind: msg.kind } as any;
      broadcast([ev]);
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
      // broadcast reset to all clients
      for (const c of state.clients.values()) send(c.socket, { t: "reset", snapshot: snap } as any);
      break;
    }
    case "listLocations": {
      (async () => {
        await ensureDataRoot();
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
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
        send(client.socket, { t: "savedOk", path: rel } as any);
        // optionally refresh list
        const tree = await buildLocationsTree();
        const lastUsedPath = await tryReadLastUsed();
        send(client.socket, { t: "locationsTree", tree, lastUsedPath } as any);
      })();
      break;
    }
    case "loadLocation": {
      if (client.role !== "DM") return;
      (async () => {
        await ensureDataRoot();
        const rel = msg.path;
        const safe = withinDataRoot(rel);
        if (!safe) return send(client.socket, { t: "error", message: "Invalid path" });
        try {
          const snap = await readJSON<GameSnapshot>(safe);
          applySnapshot(snap);
          await writeLastUsed(rel);
          // broadcast reset
          for (const c of state.clients.values()) send(c.socket, { t: "reset", snapshot: snap } as any);
        } catch (e) {
          send(client.socket, { t: "error", message: "Failed to load location" });
        }
      })();
      break;
    }
  }
}

function clampVec(v: Vec2, min: Vec2, max: Vec2): Vec2 {
  return { x: Math.max(min.x, Math.min(max.x, v.x)), y: Math.max(min.y, Math.min(max.y, v.y)) };
}

function cellKey(v: Vec2): string { return `${v.x},${v.y}`; }
function getFogSet(levelId: ID): Set<string> {
  let s = state.fog.get(levelId);
  if (!s) { s = new Set(); state.fog.set(levelId, s); }
  return s;
}

function findAssetIdAt(levelId: ID, pos: Vec2): ID | null {
  for (const [id, a] of state.assets.entries()) {
    if (a.levelId === levelId && a.pos.x === pos.x && a.pos.y === pos.y) return id;
  }
  return null;
}

// --- world helpers (mirror client) ---
function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hash2D(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + seed) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}
function isLand(gx: number, gy: number): boolean {
  if (gx < 0 || gx >= 10 || gy < 0 || gy >= 10) return false;
  const seed = state.location.levels[0]?.seed || "seed-1";
  const s = (hashString(seed) ^ 0xa5a5a5a5) >>> 0;
  const edge = Math.min(gx, gy, 9 - gx, 9 - gy);
  if (edge === 0) {
    const h = hash2D(gx, gy, s);
    if ((h & 0xff) < 50) return false;
  } else if (edge === 1) {
    const h = hash2D(gx * 3 + 7, gy * 5 + 11, s);
    if ((h & 0xff) < 20) return false;
  }
  return true;
}

function makePlayerToken(playerId: ID, levelId: ID, spawn: Vec2): Token {
  return {
    id: "t-" + randomUUID(),
    owner: playerId,
    levelId,
    pos: { ...spawn },
    vision: { radius: 8, angle: 360 },
    light: null,
    flags: {},
    name: "Player"
  };
}

function snapshot(): { snapshot: { location: Location; tokens: Token[]; assets: Asset[]; events: Event[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[] } } {
  const events: Event[] = [];
  for (const [lvl, set] of state.fog.entries()) {
    const cells = Array.from(set).map((k) => {
      const [xs, ys] = k.split(",");
      return { x: Number(xs), y: Number(ys) } as Vec2;
    });
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
  return { snapshot: { location: state.location, tokens: Array.from(state.tokens.values()), assets: Array.from(state.assets.values()), events, floors: floorsArr } };
}

function onConnection(ws: import("ws").WebSocket, req: IncomingMessage) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  const invite = url.searchParams.get("inv");
  const role = roleFromInvite(invite);
  const clientId = "p-" + randomUUID();
  const client: ClientRec = { id: clientId, role, socket: ws };
  state.clients.set(clientId, client);

  const levelId = state.location.levels[0].id;
  const spawn = state.location.levels[0].spawnPoint;
  // Spawn exactly 3 default tokens side-by-side on first connection
  const tokensToBroadcast: Event[] = [];
  if (state.tokens.size === 0) {
    const starts: Vec2[] = [
      { x: Math.max(0, spawn.x - 1), y: spawn.y },
      { x: spawn.x, y: spawn.y },
      { x: Math.min(9, spawn.x + 1), y: spawn.y },
    ].filter((p) => isLand(p.x, p.y));
    for (const p of starts) {
      const t = makePlayerToken(clientId, levelId, p);
      state.tokens.set(t.id, t);
      tokensToBroadcast.push({ type: "tokenSpawned", token: t } as any);
    }
  }
  // Ensure at least one token exists for snapshot even if not first connection
  if (state.tokens.size === 0) {
    const p = isLand(spawn.x, spawn.y) ? spawn : { x: 5, y: 5 };
    const t = makePlayerToken(clientId, levelId, p);
    state.tokens.set(t.id, t);
    tokensToBroadcast.push({ type: "tokenSpawned", token: t } as any);
  }
  // Ensure fog set exists for default level
  getFogSet(levelId);

  // Send welcome with snapshot
  send(ws, { t: "welcome", playerId: clientId, role, ...snapshot() });

  // Notify others about new tokens (if any)
  if (tokensToBroadcast.length) broadcast(tokensToBroadcast);

  ws.on("message", (data: import("ws").RawData) => onMessage(client, data));
  ws.on("close", () => {
    state.clients.delete(clientId);
  });
}

async function start() {
  await ensureDataRoot();
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
  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", onConnection);
  server.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
  });
}

start();
