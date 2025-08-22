import type { ID, Vec2, Role, GameSnapshot, FloorKind, LocationTreeNode } from "./types";

export type ClientToServer =
  | { t: "join"; name?: string; invite?: string }
  | { t: "moveToken"; tokenId: ID; pos: Vec2; levelId: ID }
  | { t: "revealFog"; levelId: ID; cells: Vec2[] }
  | { t: "obscureFog"; levelId: ID; cells: Vec2[] }
  | { t: "placeAsset"; levelId: ID; pos: Vec2; kind: string; rot?: number; scale?: number; tint?: number }
  | { t: "removeAssetAt"; levelId: ID; pos: Vec2 }
  | { t: "toggleDoor"; assetId: ID }
  | { t: "paintFloor"; levelId: ID; pos: Vec2; kind: FloorKind | null }
  | { t: "requestSave" }
  | { t: "loadSnapshot"; snapshot: GameSnapshot }
  // server-side locations management
  | { t: "listLocations" }
  | { t: "saveLocation"; path: string } // path relative to server locations root, e.g. "my/maps/test.json"
  | { t: "loadLocation"; path: string };

export type ServerToClient =
  | { t: "welcome"; playerId: ID; role: Role; snapshot: GameSnapshot }
  | { t: "statePatch"; events: any[] }
  | { t: "saveData"; snapshot: GameSnapshot }
  | { t: "reset"; snapshot: GameSnapshot }
  | { t: "error"; message: string }
  // locations list response
  | { t: "locationsTree"; tree: LocationTreeNode[]; lastUsedPath?: string }
  | { t: "savedOk"; path: string };
