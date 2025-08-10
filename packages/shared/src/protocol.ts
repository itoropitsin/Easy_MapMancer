import type { ID, Vec2, Role, GameSnapshot, FloorKind } from "./types";

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
  | { t: "loadSnapshot"; snapshot: GameSnapshot };

export type ServerToClient =
  | { t: "welcome"; playerId: ID; role: Role; snapshot: GameSnapshot }
  | { t: "statePatch"; events: any[] }
  | { t: "saveData"; snapshot: GameSnapshot }
  | { t: "reset"; snapshot: GameSnapshot }
  | { t: "error"; message: string };
