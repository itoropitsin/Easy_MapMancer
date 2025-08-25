import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import type { Server as HTTPServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { ServerResponse } from "node:http";
import type { ServerToClient, ClientToServer, Location, Level, Token, Vec2, Role, ID, Event, Asset, FloorKind, LocationTreeNode, GameSnapshot } from "@dnd/shared";

const PORT = Number(process.env.PORT || 8080);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_ROOT = process.env.LOCATIONS_DIR || path.resolve(__dirname, "../data/locations");
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

// Current file path for autosave (relative to DATA_ROOT)
let currentSavePath: string | null = null;

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
        let include = false;
        try {
          const snap = await readJSON<GameSnapshot>(fileAbs);
          const loc: any = (snap as any)?.location;
          const hasValidLocation = !!loc && typeof loc.name === "string" && typeof loc.id === "string" && Array.isArray(loc.levels);
          if (hasValidLocation) {
            locationName = loc.name;
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
          try { console.debug(`[LOC][server] include file: ${rel} (name="${locationName}")`); } catch {}
        } else {
          try { console.debug(`[LOC][server] skip file: ${rel} (no valid location)`); } catch {}
        }
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

function persistIfAutosave() {
  if (!currentSavePath) return;
  (async () => {
    try {
      const safe = withinDataRoot(currentSavePath!);
      if (!safe) return;
      const { snapshot: snap } = snapshot();
      await writeJSON(safe, snap);
    } catch (e) {
      // ignore autosave errors for now
    }
  })();
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
    case "spawnToken": {
      if (client.role !== "DM") return;
      const kind = (msg as any).kind === "npc" ? "npc" : "player";
      const level: ID = (msg as any).levelId || state.location.levels[0]?.id || "L1";
      const basePos: Vec2 = (msg as any).pos || state.location.levels[0]?.spawnPoint || { x: 5, y: 5 };
      // clamp inside bounds
      let pos = clampVec(basePos, { x: 0, y: 0 }, { x: 9, y: 9 });
      const hasFloor = (() => {
        const m = state.floors.get(level);
        if (!m) return false;
        return m.has(`${pos.x},${pos.y}`);
      })();
      // If not land or floor, try to snap to spawnPoint
      if (!isLand(pos.x, pos.y) && !hasFloor) {
        const sp = state.location.levels[0]?.spawnPoint || { x: 5, y: 5 };
        pos = clampVec(sp, { x: 0, y: 0 }, { x: 9, y: 9 });
      }
      // If occupied, search small spiral for a free nearby cell
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
          const p = clampVec({ x: pos.x + d.x, y: pos.y + d.y }, { x: 0, y: 0 }, { x: 9, y: 9 });
          const hasFloor2 = (() => {
            const m = state.floors.get(level);
            if (!m) return false;
            return m.has(`${p.x},${p.y}`);
          })();
          if (!occupied(p) && (isLand(p.x, p.y) || hasFloor2)) { pos = p; break; }
        }
      }
      const owner: ID = (msg as any).owner || client.id;
      const t = kind === "npc" ? makeNPCToken(owner, level, pos) : makePlayerToken(owner, level, pos);
      state.tokens.set(t.id, t);
      broadcast([{ type: "tokenSpawned", token: t } as any]);
      persistIfAutosave();
      break;
    }
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
      const events: Event[] = [];
      events.push({ type: "tokenMoved", tokenId: tok.id, pos, levelId: tok.levelId } as any);
      // Auto-reveal fog based on token's vision radius, but ONLY for player tokens
      const isNPC = (tok as any).kind === "npc";
      if (!isNPC) {
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
      broadcast(events);
      persistIfAutosave();
      break;
    }
    case "updateToken": {
      const tok = state.tokens.get(msg.tokenId);
      if (!tok) break;
      // Only DM or token owner can update
      if (client.role !== "DM" && tok.owner !== client.id) break;
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
      if (patch.vision && typeof patch.vision === "object") {
        const vr = Math.max(0, Math.min(20, Math.round((patch.vision as any).radius ?? (tok.vision?.radius ?? 8))));
        const ang = (patch.vision as any).angle ?? (tok.vision?.angle ?? 360);
        tok.vision = { radius: vr, angle: ang };
      }
      state.tokens.set(tok.id, tok);
      broadcast([{ type: "tokenUpdated", token: tok } as any]);
      persistIfAutosave();
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
        persistIfAutosave();
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
        persistIfAutosave();
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
      persistIfAutosave();
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
      persistIfAutosave();
      break;
    }
    case "removeTokenAt": {
      if (client.role !== "DM") return;
      const gx = Math.floor((msg as any).pos.x);
      const gy = Math.floor((msg as any).pos.y);
      const removed: ID[] = [];
      for (const [id, t] of state.tokens.entries()) {
        if (t.levelId === (msg as any).levelId && t.pos.x === gx && t.pos.y === gy) {
          state.tokens.delete(id);
          removed.push(id);
        }
      }
      if (removed.length === 0) return;
      broadcast(removed.map((id) => ({ type: "tokenRemoved", tokenId: id } as any)));
      persistIfAutosave();
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
      persistIfAutosave();
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

// Generate a bright-ish random color (each channel in [128..255])
function randomBrightColor(): number {
  const ch = () => (128 + Math.floor(Math.random() * 128)) & 0xff;
  return (ch() << 16) | (ch() << 8) | ch();
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
  };
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
  // Do NOT auto-spawn tokens on connect. Tokens are added explicitly via 'spawnToken'.
  // Ensure fog set exists for default level
  getFogSet(levelId);

  // Send welcome with snapshot
  send(ws, { t: "welcome", playerId: clientId, role, ...snapshot() });

  ws.on("message", (data: import("ws").RawData) => onMessage(client, data));
  ws.on("close", () => {
    state.clients.delete(clientId);
  });
}

async function start() {
  await ensureDataRoot();
  // Log resolved data root for diagnostics
  try { console.log(`[server] DATA_ROOT: ${DATA_ROOT}`); } catch {}
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
