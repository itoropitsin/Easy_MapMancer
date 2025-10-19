import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { promises as fs, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
const PORT = Number(process.env.PORT || 8080);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve data directory robustly for both dev (tsx) and build (dist):
// 1) LOCATIONS_DIR env
// 2) ../data/locations relative to compiled file
// 3) ../../data/locations (if running from nested dist path)
function resolveDataRoot() {
    const fromEnv = process.env.LOCATIONS_DIR;
    if (fromEnv && fromEnv.trim())
        return path.resolve(fromEnv);
    const candidates = [
        path.resolve(__dirname, "../data/locations"),
        path.resolve(__dirname, "../../data/locations"),
    ];
    for (const p of candidates) {
        try {
            // statSync avoids needing async before first use; will throw if not exists
            const st = statSync(p);
            if (st && st.isDirectory())
                return p;
        }
        catch { }
    }
    // fallback to first candidate
    return candidates[0];
}
const DATA_ROOT = resolveDataRoot();
const LAST_USED_FILE = path.resolve(DATA_ROOT, "last-used.json");
function applySnapshot(snap) {
    const payload = snap;
    const loc = payload.location;
    // replace state with defensive defaults so legacy saves still load
    state.location = (loc && typeof loc === "object" && Array.isArray(loc.levels))
        ? loc
        : makeDefaultLocation();
    state.tokens.clear();
    const tokens = Array.isArray(payload.tokens) ? payload.tokens : [];
    for (const t of tokens) {
        if (!t || !t.id)
            continue;
        state.tokens.set(t.id, t);
    }
    state.assets.clear();
    const assets = Array.isArray(payload.assets) ? payload.assets : [];
    for (const a of assets) {
        if (!a || !a.id)
            continue;
        state.assets.set(a.id, a);
    }
    state.fog.clear();
    // rebuild fog from snapshot events if present
    const events = Array.isArray(payload.events) ? payload.events : [];
    for (const e of events) {
        if (e.type === "fogRevealed") {
            const s = getFogSet(e.levelId);
            for (const c of e.cells)
                s.add(cellKey(c));
        }
    }
    state.floors.clear();
    const floors = Array.isArray(payload.floors)
        ? payload.floors
        : [];
    for (const f of floors) {
        if (!f?.levelId || !f.pos)
            continue;
        let m = state.floors.get(f.levelId);
        if (!m) {
            m = new Map();
            state.floors.set(f.levelId, m);
        }
        m.set(`${f.pos.x},${f.pos.y}`, f.kind);
    }
    const addedFloors = ensureDefaultFloorsForAllLevels();
    if (addedFloors.length > 0) {
        const existing = new Set(Array.isArray(payload.floors)
            ? payload.floors.map((f) => `${f.levelId}:${f.pos.x},${f.pos.y}`)
            : []);
        const merged = Array.isArray(payload.floors)
            ? payload.floors.slice()
            : [];
        for (const f of addedFloors) {
            const key = `${f.levelId}:${f.pos.x},${f.pos.y}`;
            if (existing.has(key))
                continue;
            existing.add(key);
            merged.push({ levelId: f.levelId, pos: { ...f.pos }, kind: f.kind });
        }
        payload.floors = merged;
    }
}
const DEFAULT_FLOOR_KIND = "stone";
const DEFAULT_FLOOR_WIDTH = 10;
const DEFAULT_FLOOR_HEIGHT = 10;
function ensureDefaultFloorsForLevel(levelId) {
    let map = state.floors.get(levelId);
    if (!map) {
        map = new Map();
        state.floors.set(levelId, map);
    }
    const added = [];
    for (let y = 0; y < DEFAULT_FLOOR_HEIGHT; y++) {
        for (let x = 0; x < DEFAULT_FLOOR_WIDTH; x++) {
            const key = `${x},${y}`;
            if (map.has(key))
                continue;
            map.set(key, DEFAULT_FLOOR_KIND);
            added.push({ levelId, pos: { x, y }, kind: DEFAULT_FLOOR_KIND });
        }
    }
    return added;
}
function ensureDefaultFloorsForAllLevels() {
    const added = [];
    for (const lvl of state.location.levels) {
        added.push(...ensureDefaultFloorsForLevel(lvl.id));
    }
    return added;
}
function makeDefaultLevel() {
    return {
        id: "L1",
        seed: "seed-1",
        spawnPoint: { x: 5, y: 5 },
        lights: []
    };
}
function makeDefaultLocation() {
    return {
        id: "LOC1",
        name: "Demo Location",
        levels: [makeDefaultLevel()],
        settings: {}
    };
}
const state = {
    location: makeDefaultLocation(),
    tokens: new Map(),
    clients: new Map(),
    fog: new Map(),
    assets: new Map(),
    floors: new Map(),
};
ensureDefaultFloorsForAllLevels();
// Current file path for autosave (relative to DATA_ROOT)
let currentSavePath = null;
// ---- Persistence helpers ----
async function ensureDataRoot() {
    await fs.mkdir(DATA_ROOT, { recursive: true });
}
function withinDataRoot(rel) {
    const target = path.resolve(DATA_ROOT, rel);
    if (!target.startsWith(path.resolve(DATA_ROOT) + path.sep))
        return null;
    return target;
}
async function readJSON(file) {
    // Read as UTF-8 string and strip a possible UTF-8 BOM which would break JSON.parse
    let buf = await fs.readFile(file, "utf8");
    if (buf && buf.charCodeAt(0) === 0xfeff)
        buf = buf.slice(1);
    try {
        return JSON.parse(buf);
    }
    catch (e) {
        // Attempt to salvage by trimming any trailing garbage after the first complete JSON value
        try {
            const end = findEndOfFirstJSONValue(buf);
            if (end != null && end > 0) {
                const trimmed = buf.slice(0, end).trimEnd();
                const parsed = JSON.parse(trimmed);
                try {
                    console.warn(`[LOC][server] readJSON: trailing content trimmed for ${path.relative(DATA_ROOT, file)} keptChars=${end}/${buf.length}`);
                }
                catch { }
                return parsed;
            }
        }
        catch { }
        throw e;
    }
}
// Find the end index (exclusive) of the first complete JSON value in a string.
// Handles objects/arrays, strings with escapes, and nesting. Returns null if not found.
function findEndOfFirstJSONValue(s) {
    let i = 0;
    const n = s.length;
    // skip leading whitespace
    while (i < n && /\s/.test(s[i]))
        i++;
    if (i >= n)
        return null;
    const start = i;
    const ch = s[i];
    // For primitives, JSON.parse would succeed or fail differently; we care about object/array roots
    if (ch !== '{' && ch !== '[')
        return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (; i < n; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) {
                esc = false;
                continue;
            }
            if (c === '\\') {
                esc = true;
                continue;
            }
            if (c === '"') {
                inStr = false;
                continue;
            }
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === '{' || c === '[') {
            depth++;
            continue;
        }
        if (c === '}' || c === ']') {
            depth--;
            if (depth === 0) {
                i++;
                break;
            }
            continue;
        }
    }
    if (depth !== 0)
        return null;
    // include trailing whitespace after the value
    while (i < n && /\s/.test(s[i]))
        i++;
    return i;
}
async function writeJSON(file, obj) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}
async function tryReadLastUsed() {
    try {
        const data = await readJSON(LAST_USED_FILE);
        if (!data?.path)
            return null;
        const safe = withinDataRoot(data.path);
        return safe ? data.path : null;
    }
    catch {
        return null;
    }
}
async function writeLastUsed(relPath) {
    await writeJSON(LAST_USED_FILE, { path: relPath });
}
async function buildLocationsTree() {
    async function walk(dirRel) {
        const dirAbs = withinDataRoot(dirRel) ?? DATA_ROOT;
        const entries = await fs.readdir(dirAbs, { withFileTypes: true }).catch(() => []);
        const folders = [];
        const files = [];
        for (const ent of entries) {
            if (ent.name.startsWith("."))
                continue;
            if (ent.isDirectory()) {
                const children = await walk(path.join(dirRel, ent.name));
                folders.push({ type: "folder", name: ent.name, path: path.join(dirRel, ent.name) + path.sep, children });
            }
            else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) {
                if (ent.name === "last-used.json")
                    continue; // hide internal meta file if present
                const rel = path.join(dirRel, ent.name);
                const fileAbs = withinDataRoot(rel);
                try {
                    console.debug(`[LOC][server] scanning file: ${rel}`);
                }
                catch { }
                let locationName;
                let include = false;
                try {
                    const snap = await readJSON(fileAbs);
                    const loc = snap?.location;
                    const hasValidLocation = !!loc && typeof loc.name === "string" && typeof loc.id === "string" && Array.isArray(loc.levels);
                    if (hasValidLocation) {
                        locationName = loc.name;
                        include = true;
                    }
                }
                catch (e) {
                    try {
                        // Inspect first few bytes to detect encoding/BOM issues
                        let firstBytes = "";
                        try {
                            const raw = await fs.readFile(fileAbs);
                            firstBytes = Array.from(raw.slice(0, 4)).map((b) => b.toString(16).padStart(2, "0")).join(" ");
                        }
                        catch { }
                        console.warn(`[LOC][server] failed to parse JSON: ${rel} err=${e?.message ?? e} firstBytes=[${firstBytes}]`);
                    }
                    catch { }
                }
                if (include) {
                    files.push({ type: "file", name: ent.name.replace(/\.json$/i, ""), path: rel, locationName });
                    try {
                        console.debug(`[LOC][server] include file: ${rel} (name="${locationName}")`);
                    }
                    catch { }
                }
                else {
                    try {
                        console.debug(`[LOC][server] skip file: ${rel} (no valid location)`);
                    }
                    catch { }
                }
            }
        }
        folders.sort((a, b) => a.name.localeCompare(b.name, "ru"));
        files.sort((a, b) => a.name.localeCompare(b.name, "ru"));
        return [...folders, ...files];
    }
    return walk("");
}
function roleFromInvite(inv) {
    if (!inv)
        return "PLAYER";
    if (inv.startsWith("dm-"))
        return "DM";
    return "PLAYER";
}
function send(ws, msg) {
    ws.send(JSON.stringify(msg));
}
function broadcast(events) {
    for (const c of state.clients.values()) {
        send(c.socket, { t: "statePatch", events });
    }
}
function persistIfAutosave() {
    if (!currentSavePath)
        return;
    (async () => {
        try {
            const safe = withinDataRoot(currentSavePath);
            if (!safe)
                return;
            const { snapshot: snap } = snapshot();
            await writeJSON(safe, snap);
        }
        catch (e) {
            // ignore autosave errors for now
        }
    })();
}
function onMessage(client, data) {
    let msg;
    try {
        msg = JSON.parse(String(data));
    }
    catch (e) {
        return send(client.socket, { t: "error", message: "Invalid JSON" });
    }
    if (!msg || typeof msg !== "object" || !("t" in msg))
        return;
    switch (msg.t) {
        case "ping": {
            send(client.socket, { t: "pong" });
            break;
        }
        case "spawnToken": {
            if (client.role !== "DM")
                return;
            const kind = msg.kind === "npc" ? "npc" : "player";
            const level = msg.levelId || state.location.levels[0]?.id || "L1";
            const basePos = msg.pos || state.location.levels[0]?.spawnPoint || { x: 5, y: 5 };
            ensureDefaultFloorsForLevel(level);
            const levelFloors = state.floors.get(level);
            const parseKey = (key) => {
                const [sx, sy] = key.split(",");
                return { x: Number.parseInt(sx, 10) || 0, y: Number.parseInt(sy, 10) || 0 };
            };
            let pos = { x: Math.floor(basePos.x), y: Math.floor(basePos.y) };
            if (!hasFloorAt(level, pos)) {
                const spawn = state.location.levels.find((lvl) => lvl.id === level)?.spawnPoint ?? { x: 5, y: 5 };
                if (hasFloorAt(level, spawn)) {
                    pos = { x: Math.floor(spawn.x), y: Math.floor(spawn.y) };
                }
                else if (levelFloors && levelFloors.size > 0) {
                    const firstIter = levelFloors.keys().next();
                    if (!firstIter.done && typeof firstIter.value === "string") {
                        pos = parseKey(firstIter.value);
                    }
                    else {
                        return;
                    }
                }
                else {
                    return;
                }
            }
            function occupied(p) {
                for (const t of state.tokens.values()) {
                    if (t.levelId === level && t.pos.x === p.x && t.pos.y === p.y)
                        return true;
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
                    if (!hasFloorAt(level, p))
                        continue;
                    if (!occupied(p)) {
                        pos = p;
                        break;
                    }
                }
            }
            const owner = msg.owner || client.id;
            const t = kind === "npc" ? makeNPCToken(owner, level, pos) : makePlayerToken(owner, level, pos);
            state.tokens.set(t.id, t);
            broadcast([{ type: "tokenSpawned", token: t }]);
            persistIfAutosave();
            break;
        }
        case "moveToken": {
            const tok = state.tokens.get(msg.tokenId);
            if (!tok)
                return;
            if (client.role !== "DM" && tok.owner !== client.id)
                return;
            // Normalize target to integer grid
            const target = { x: Math.floor(msg.pos.x), y: Math.floor(msg.pos.y) };
            ensureDefaultFloorsForLevel(msg.levelId);
            if (!hasFloorAt(msg.levelId, target))
                return;
            const pos = target;
            tok.pos = pos;
            tok.levelId = msg.levelId;
            const events = [];
            events.push({ type: "tokenMoved", tokenId: tok.id, pos, levelId: tok.levelId });
            // Auto-reveal fog based on token's vision radius, but ONLY for player tokens
            const isNPC = tok.kind === "npc";
            if (!isNPC) {
                const vr = Math.max(0, Math.min(20, Math.round(tok.vision?.radius ?? 0)));
                if (vr > 0) {
                    const fog = getFogSet(tok.levelId);
                    const cells = cellsInRadius(tok.pos, vr);
                    const added = [];
                    for (const c of cells) {
                        const k = cellKey(c);
                        if (!fog.has(k)) {
                            fog.add(k);
                            added.push({ x: c.x, y: c.y });
                        }
                    }
                    if (added.length > 0)
                        events.push({ type: "fogRevealed", levelId: tok.levelId, cells: added });
                }
            }
            broadcast(events);
            persistIfAutosave();
            break;
        }
        case "updateToken": {
            const tok = state.tokens.get(msg.tokenId);
            if (!tok)
                break;
            // Only DM or token owner can update
            if (client.role !== "DM" && tok.owner !== client.id)
                break;
            const patch = msg.patch;
            // Apply whitelisted fields
            if (typeof patch.name === "string")
                tok.name = String(patch.name).slice(0, 64);
            if (typeof patch.hp === "number")
                tok.hp = Math.max(0, Math.min(999, Math.round(patch.hp)));
            if (typeof patch.ac === "number")
                tok.ac = Math.max(0, Math.min(50, Math.round(patch.ac)));
            if (typeof patch.tint === "number")
                tok.tint = patch.tint >>> 0;
            if (patch.stats && typeof patch.stats === "object") {
                tok.stats = { ...(tok.stats ?? {}), ...patch.stats };
                // sanitize numeric stats if present
                const keys = ["str", "dex", "con", "int", "wis", "cha", "hp", "ac"];
                for (const k of keys) {
                    const v = tok.stats[k];
                    if (typeof v === "number")
                        tok.stats[k] = Math.max(0, Math.min(999, Math.round(v)));
                }
            }
            if (typeof patch.notes === "string") {
                tok.notes = patch.notes.slice(0, 2000);
            }
            else if (patch.notes === null) {
                delete tok.notes;
            }
            if (patch.vision && typeof patch.vision === "object") {
                const vr = Math.max(0, Math.min(20, Math.round(patch.vision.radius ?? (tok.vision?.radius ?? 8))));
                const ang = patch.vision.angle ?? (tok.vision?.angle ?? 360);
                tok.vision = { radius: vr, angle: ang };
            }
            state.tokens.set(tok.id, tok);
            broadcast([{ type: "tokenUpdated", token: tok }]);
            persistIfAutosave();
            break;
        }
        case "revealFog": {
            if (client.role !== "DM")
                return;
            const levelFog = getFogSet(msg.levelId);
            const added = [];
            for (const c of msg.cells) {
                const k = cellKey(c);
                if (!levelFog.has(k)) {
                    levelFog.add(k);
                    added.push({ x: c.x, y: c.y });
                }
            }
            if (added.length > 0) {
                const ev = { type: "fogRevealed", levelId: msg.levelId, cells: added };
                broadcast([ev]);
                persistIfAutosave();
            }
            break;
        }
        case "obscureFog": {
            if (client.role !== "DM")
                return;
            const levelFog = getFogSet(msg.levelId);
            const removed = [];
            for (const c of msg.cells) {
                const k = cellKey(c);
                if (levelFog.has(k)) {
                    levelFog.delete(k);
                    removed.push({ x: c.x, y: c.y });
                }
            }
            if (removed.length > 0) {
                const ev = { type: "fogObscured", levelId: msg.levelId, cells: removed };
                broadcast([ev]);
                persistIfAutosave();
            }
            break;
        }
        case "placeAsset": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            ensureDefaultFloorsForLevel(msg.levelId);
            if (!hasFloorAtXY(msg.levelId, gx, gy))
                return;
            // remove existing asset at pos (single asset per cell policy)
            const existingId = findAssetIdAt(msg.levelId, { x: gx, y: gy });
            if (existingId)
                state.assets.delete(existingId);
            const asset = {
                id: "a-" + randomUUID(),
                levelId: msg.levelId,
                pos: { x: gx, y: gy },
                kind: msg.kind,
                rot: msg.rot,
                scale: msg.scale,
                tint: msg.tint,
            };
            state.assets.set(asset.id, asset);
            broadcast([{ type: "assetPlaced", asset }]);
            persistIfAutosave();
            break;
        }
        case "removeAssetAt": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            const removed = [];
            for (const [id, a] of state.assets.entries()) {
                if (a.levelId === msg.levelId && a.pos.x === gx && a.pos.y === gy) {
                    state.assets.delete(id);
                    removed.push(id);
                }
            }
            if (removed.length === 0)
                return;
            broadcast(removed.map((id) => ({ type: "assetRemoved", assetId: id })));
            persistIfAutosave();
            break;
        }
        case "removeTokenAt": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            const removed = [];
            for (const [id, t] of state.tokens.entries()) {
                if (t.levelId === msg.levelId && t.pos.x === gx && t.pos.y === gy) {
                    state.tokens.delete(id);
                    removed.push(id);
                }
            }
            if (removed.length === 0)
                return;
            broadcast(removed.map((id) => ({ type: "tokenRemoved", tokenId: id })));
            persistIfAutosave();
            break;
        }
        case "toggleDoor": {
            // Allow both DM and players to toggle doors
            const a = state.assets.get(msg.assetId);
            if (!a)
                return;
            if (a.kind !== "door")
                return;
            a.open = !(a.open === true);
            state.assets.set(a.id, a);
            broadcast([{ type: "assetPlaced", asset: a }]);
            persistIfAutosave();
            break;
        }
        case "paintFloor": {
            if (client.role !== "DM")
                return;
            const gx = Math.floor(msg.pos.x);
            const gy = Math.floor(msg.pos.y);
            const key = cellKey({ x: gx, y: gy });
            let level = state.floors.get(msg.levelId);
            if (!level) {
                level = new Map();
                state.floors.set(msg.levelId, level);
            }
            if (msg.kind == null) {
                level.delete(key);
            }
            else {
                level.set(key, msg.kind);
            }
            const ev = { type: "floorPainted", levelId: msg.levelId, pos: { x: gx, y: gy }, kind: msg.kind };
            broadcast([ev]);
            persistIfAutosave();
            break;
        }
        case "requestSave": {
            // anyone can request their own save snapshot; typically DM
            const { snapshot: snap } = snapshot();
            send(client.socket, { t: "saveData", snapshot: snap });
            break;
        }
        case "loadSnapshot": {
            if (client.role !== "DM")
                return;
            const snap = msg.snapshot;
            applySnapshot(snap);
            (async () => {
                try {
                    await ensureDataRoot();
                    currentSavePath = null; // not yet saved to a file
                    await writeLastUsed(""); // clear last used until explicit save
                }
                catch { }
                // broadcast reset to all clients
                for (const c of state.clients.values())
                    send(c.socket, { t: "reset", snapshot: snap });
                // refresh locations tree for the initiating client
                try {
                    const tree = await buildLocationsTree();
                    const lastUsedPath = await tryReadLastUsed();
                    try {
                        const exists = (nodes) => {
                            for (const n of nodes) {
                                const nn = n;
                                if (nn.type === "file") {
                                    const p = String(nn.path || "").toLowerCase();
                                    if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                        return true;
                                }
                                if (Array.isArray(nn.children) && nn.children.length) {
                                    if (exists(nn.children))
                                        return true;
                                }
                            }
                            return false;
                        };
                        const hasDemo = exists(tree);
                        console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                    }
                    catch { }
                    send(client.socket, { t: "locationsTree", tree, lastUsedPath });
                }
                catch { }
            })();
            break;
        }
        case "loadLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path.endsWith(".json") ? msg.path : msg.path + ".json";
                const safe = withinDataRoot(rel);
                if (!safe)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                try {
                    const snap = await readJSON(safe);
                    applySnapshot(snap);
                    currentSavePath = rel;
                    await writeLastUsed(rel);
                    // broadcast reset to all clients
                    for (const c of state.clients.values())
                        send(c.socket, { t: "reset", snapshot: snap });
                    // refresh locations list for the requester
                    const tree = await buildLocationsTree();
                    const lastUsedPath = await tryReadLastUsed();
                    try {
                        const exists = (nodes) => {
                            for (const n of nodes) {
                                const nn = n;
                                if (nn.type === "file") {
                                    const p = String(nn.path || "").toLowerCase();
                                    if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                        return true;
                                }
                                if (Array.isArray(nn.children) && nn.children.length) {
                                    if (exists(nn.children))
                                        return true;
                                }
                            }
                            return false;
                        };
                        const hasDemo = exists(tree);
                        console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                    }
                    catch { }
                    send(client.socket, { t: "locationsTree", tree, lastUsedPath });
                }
                catch {
                    send(client.socket, { t: "error", message: "Failed to load location" });
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
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "saveLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path.endsWith(".json") ? msg.path : msg.path + ".json";
                const safe = withinDataRoot(rel);
                if (!safe)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                const { snapshot: snap } = snapshot();
                await writeJSON(safe, snap);
                await writeLastUsed(rel);
                currentSavePath = rel;
                send(client.socket, { t: "savedOk", path: rel });
                // optionally refresh list
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "createFolder": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
                const dirAbs = withinDataRoot(path.join(rel, path.sep));
                if (!dirAbs)
                    return send(client.socket, { t: "error", message: "Invalid folder path" });
                await fs.mkdir(dirAbs, { recursive: true });
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "deleteLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const rel = msg.path;
                const safe = withinDataRoot(rel);
                if (!safe)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                try {
                    await fs.unlink(safe);
                    if (currentSavePath === rel)
                        currentSavePath = null;
                    const last = await tryReadLastUsed();
                    if (last === rel)
                        await writeLastUsed("");
                }
                catch {
                    // ignore
                }
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "moveLocation": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                const fromRel = msg.from;
                const toFolderRel = msg.toFolder.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
                const fromAbs = withinDataRoot(fromRel);
                const toDirAbs = toFolderRel === "" ? DATA_ROOT : withinDataRoot(path.join(toFolderRel, path.sep));
                if (!fromAbs || !toDirAbs)
                    return send(client.socket, { t: "error", message: "Invalid path" });
                await fs.mkdir(toDirAbs, { recursive: true });
                const base = path.basename(fromRel);
                const toRel = path.join(toFolderRel, base);
                const toAbs = withinDataRoot(toRel);
                try {
                    await fs.rename(fromAbs, toAbs);
                    if (currentSavePath === fromRel) {
                        currentSavePath = toRel;
                        await writeLastUsed(toRel);
                    }
                }
                catch (e) {
                    send(client.socket, { t: "error", message: "Failed to move location" });
                }
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
        case "renameFolder": {
            if (client.role !== "DM")
                return;
            (async () => {
                await ensureDataRoot();
                // sanitize inputs
                const rel = String(msg.path || "").replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
                const newName = String(msg.newName || "").replace(/\s+/g, " ").trim();
                if (!rel)
                    return send(client.socket, { t: "error", message: "Invalid folder path" });
                if (!newName || /[\\/]/.test(newName))
                    return send(client.socket, { t: "error", message: "Invalid new name" });
                const fromAbs = withinDataRoot(rel);
                if (!fromAbs)
                    return send(client.socket, { t: "error", message: "Invalid folder path" });
                // ensure target exists and is a directory
                try {
                    const st = await fs.stat(fromAbs);
                    if (!st.isDirectory())
                        return send(client.socket, { t: "error", message: "Not a folder" });
                }
                catch {
                    return send(client.socket, { t: "error", message: "Folder not found" });
                }
                const parentRel = path.dirname(rel);
                const toRel = parentRel === "." ? newName : path.join(parentRel, newName);
                const toAbs = withinDataRoot(toRel);
                if (!toAbs)
                    return send(client.socket, { t: "error", message: "Invalid rename target" });
                try {
                    await fs.rename(fromAbs, toAbs);
                    // update currentSavePath and last-used if they reside under renamed directory
                    if (currentSavePath && (currentSavePath === rel || currentSavePath.startsWith(rel + "/"))) {
                        const updated = currentSavePath.replace(rel, toRel);
                        currentSavePath = updated;
                        try {
                            await writeLastUsed(updated);
                        }
                        catch { }
                    }
                }
                catch (e) {
                    return send(client.socket, { t: "error", message: "Failed to rename folder" });
                }
                const tree = await buildLocationsTree();
                const lastUsedPath = await tryReadLastUsed();
                try {
                    const exists = (nodes) => {
                        for (const n of nodes) {
                            const nn = n;
                            if (nn.type === "file") {
                                const p = String(nn.path || "").toLowerCase();
                                if (nn.name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json"))
                                    return true;
                            }
                            if (Array.isArray(nn.children) && nn.children.length) {
                                if (exists(nn.children))
                                    return true;
                            }
                        }
                        return false;
                    };
                    const hasDemo = exists(tree);
                    console.debug(`[LOC][server] sending locationsTree: nodes=${tree.length}, lastUsed=${lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
                }
                catch { }
                send(client.socket, { t: "locationsTree", tree, lastUsedPath });
            })();
            break;
        }
    }
}
function cellKey(v) { return `${v.x},${v.y}`; }
function getFogSet(levelId) {
    let s = state.fog.get(levelId);
    if (!s) {
        s = new Set();
        state.fog.set(levelId, s);
    }
    return s;
}
function cellsInRadius(center, r) {
    const out = [];
    const R = Math.max(0, Math.min(20, Math.round(r || 0)));
    for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
            if (dx * dx + dy * dy <= R * R)
                out.push({ x: center.x + dx, y: center.y + dy });
        }
    }
    return out;
}
function findAssetIdAt(levelId, pos) {
    for (const [id, a] of state.assets.entries()) {
        if (a.levelId === levelId && a.pos.x === pos.x && a.pos.y === pos.y)
            return id;
    }
    return null;
}
function hasFloorAt(levelId, pos) {
    const m = state.floors.get(levelId);
    if (!m)
        return false;
    return m.has(`${pos.x},${pos.y}`);
}
function hasFloorAtXY(levelId, x, y) {
    const m = state.floors.get(levelId);
    if (!m)
        return false;
    return m.has(`${x},${y}`);
}
// Generate a bright-ish random color (each channel in [128..255])
function randomBrightColor() {
    const ch = () => (128 + Math.floor(Math.random() * 128)) & 0xff;
    return (ch() << 16) | (ch() << 8) | ch();
}
function makePlayerToken(playerId, levelId, spawn) {
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
function makeNPCToken(owner, levelId, spawn) {
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
function snapshot() {
    ensureDefaultFloorsForAllLevels();
    const events = [];
    for (const [lvl, set] of state.fog.entries()) {
        const cells = Array.from(set).map((k) => {
            const [xs, ys] = k.split(",");
            return { x: Number(xs), y: Number(ys) };
        });
        if (cells.length > 0)
            events.push({ type: "fogRevealed", levelId: lvl, cells });
    }
    // floors as entries for client bootstrap
    const floorsArr = [];
    for (const [lvl, mp] of state.floors.entries()) {
        for (const [k, kind] of mp.entries()) {
            const [xs, ys] = k.split(",");
            floorsArr.push({ levelId: lvl, pos: { x: Number(xs), y: Number(ys) }, kind });
        }
    }
    return { snapshot: { location: state.location, tokens: Array.from(state.tokens.values()), assets: Array.from(state.assets.values()), events, floors: floorsArr } };
}
function onConnection(ws, req) {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const invite = url.searchParams.get("inv");
    const role = roleFromInvite(invite);
    const clientId = "p-" + randomUUID();
    const client = { id: clientId, role, socket: ws };
    state.clients.set(clientId, client);
    const levelId = state.location.levels[0].id;
    const spawn = state.location.levels[0].spawnPoint;
    // Do NOT auto-spawn tokens on connect. Tokens are added explicitly via 'spawnToken'.
    // Ensure fog set exists for default level
    getFogSet(levelId);
    // Send welcome with snapshot
    send(ws, { t: "welcome", playerId: clientId, role, ...snapshot() });
    ws.on("message", (data) => onMessage(client, data));
    ws.on("close", () => {
        state.clients.delete(clientId);
    });
}
async function start() {
    await ensureDataRoot();
    // Log resolved data root for diagnostics
    try {
        console.log(`[server] DATA_ROOT: ${DATA_ROOT}`);
    }
    catch { }
    // Autoload last used location if present
    try {
        const rel = await tryReadLastUsed();
        if (rel) {
            const safe = withinDataRoot(rel);
            if (safe) {
                const snap = await readJSON(safe);
                applySnapshot(snap);
                console.log(`[server] autoloaded location: ${rel}`);
            }
        }
    }
    catch (e) {
        console.warn("[server] autoload skipped:", e);
    }
    const server = createServer((req, res) => {
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
            try {
                console.log(`[server] attempting to listen on http://localhost:${selectedPort} (attempt ${attempts})`);
            }
            catch { }
            await new Promise((resolve, reject) => {
                const onListening = () => {
                    server.off("error", onError);
                    resolve();
                };
                const onError = (err) => {
                    server.off("listening", onListening);
                    reject(err);
                };
                server.once("listening", onListening);
                server.once("error", onError);
                server.listen(selectedPort);
            });
            break; // success
        }
        catch (err) {
            if (err && err.code === "EADDRINUSE") {
                try {
                    console.warn(`[server] port ${selectedPort} is in use, trying next...`);
                }
                catch { }
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
        try {
            console.warn(`[server][wss] error: ${String(err?.message || err)}`);
        }
        catch { }
    });
    console.log(`[server] listening on http://localhost:${selectedPort}`);
}
start();
