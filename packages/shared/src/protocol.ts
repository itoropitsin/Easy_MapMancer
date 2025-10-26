import type { ID, Vec2, Role, GameSnapshot, FloorKind, LocationTreeNode, Token, FogMode, ActionSnapshot, LoginRequest, CreateUserRequest, ChangePasswordRequest, HistoryEvent } from "./types";

export type ClientToServer =
  | { t: "join"; name?: string; invite?: string; preferredRole?: Role }
  | { t: "ping" }
  | { t: "moveToken"; tokenId: ID; pos: Vec2; levelId: ID }
  // DM can spawn tokens explicitly
  | { t: "spawnToken"; kind: "player" | "npc"; levelId?: ID; pos?: Vec2; owner?: ID }
  // DM can remove token(s) at a specific cell
  | { t: "removeTokenAt"; levelId: ID; pos: Vec2 }
  | { t: "revealFog"; levelId: ID; cells: Vec2[] }
  | { t: "obscureFog"; levelId: ID; cells: Vec2[] }
  | { t: "placeAsset"; levelId: ID; pos: Vec2; kind: string; rot?: number; scale?: number; tint?: number }
  | { t: "moveAsset"; assetId: ID; pos: Vec2; levelId: ID }
  | { t: "removeAssetAt"; levelId: ID; pos: Vec2 }
  | { t: "toggleDoor"; assetId: ID }
  | { t: "paintFloor"; levelId: ID; pos: Vec2; kind: FloorKind | null }
  | { t: "requestSave" }
  | { t: "loadSnapshot"; snapshot: GameSnapshot }
  // server-side locations management
  | { t: "listLocations" }
  | { t: "saveLocation"; path: string } // path relative to server locations root, e.g. "my/maps/test.json"
  | { t: "createFolder"; path: string } // create folder(s) under locations root, e.g. "my/maps"
  | { t: "deleteLocation"; path: string } // delete a location file, e.g. "my/maps/test.json"
  | { t: "moveLocation"; from: string; toFolder: string } // move a file into folder; keeps file name
  | { t: "renameFolder"; path: string; newName: string } // rename a folder at path (folder paths may end with "/")
  | { t: "renameLocation"; newName: string } // rename current location
  | { t: "loadLocation"; path: string }
  | { t: "loadLocationById"; locationId: ID }
  | { t: "updateToken"; tokenId: ID; patch: Partial<Token> }
  | { t: "reorderToken"; tokenId: ID; direction: "top" | "up" | "down" | "bottom" }
  | { t: "reorderAsset"; assetId: ID; direction: "top" | "up" | "down" | "bottom" }
  | { t: "toggleTokenHidden"; tokenId: ID }
  | { t: "toggleAssetHidden"; assetId: ID }
  | { t: "switchRole"; role: Role }
  | { t: "setFogMode"; fogMode: FogMode }
  | { t: "undo" }
  | { t: "redo" }
  // User authentication
  | { t: "login"; data: LoginRequest }
  | { t: "resumeSession"; token: string }
  | { t: "logout" }
  | { t: "createUser"; data: CreateUserRequest }
  | { t: "createFirstUser"; data: CreateUserRequest }
  | { t: "checkFirstUser" }
  | { t: "listUsers" }
  | { t: "updateUserRole"; userId: ID; role: "master" | "user" }
  | { t: "deleteUser"; userId: ID }
  | { t: "resetUserPassword"; userId: ID; password?: string }
  | { t: "changeOwnPassword"; data: ChangePasswordRequest };

export type ServerToClient =
  | { t: "welcome"; playerId: ID; role: Role; snapshot: GameSnapshot; history?: HistoryEvent[] }
  | { t: "pong" }
  | { t: "statePatch"; events: any[] }
  | { t: "saveData"; snapshot: GameSnapshot }
  | { t: "reset"; snapshot: GameSnapshot }
  | { t: "error"; message: string }
  // locations list response
  | { t: "locationsTree"; tree: LocationTreeNode[]; lastUsedPath?: string }
  | { t: "savedOk"; path: string }
  | { t: "roleChanged"; role: Role }
  | { t: "locationRenamed"; newName: string }
  | { t: "undoRedoState"; undoStack: ActionSnapshot[]; redoStack: ActionSnapshot[] }
  | { t: "gameStateRestored" }
  | { t: "historySnapshot"; events: HistoryEvent[] }
  | { t: "historyEvent"; event: HistoryEvent }
  // User authentication responses
  | { t: "loginResponse"; success: boolean; user?: any; token?: string; error?: string }
  | { t: "resumeSessionResponse"; success: boolean; user?: any; token?: string; error?: string }
  | { t: "logoutResponse"; success: boolean }
  | { t: "createUserResponse"; success: boolean; user?: any; generatedPassword?: string; error?: string }
  | { t: "createFirstUserResponse"; success: boolean; user?: any; generatedPassword?: string; error?: string }
  | { t: "firstUserCheckResponse"; needsFirstUser: boolean }
  | { t: "userListResponse"; users: any[] }
  | { t: "updateUserRoleResponse"; success: boolean; error?: string }
  | { t: "deleteUserResponse"; success: boolean; error?: string }
  | { t: "resetUserPasswordResponse"; success: boolean; userId?: ID; generatedPassword?: string; error?: string }
  | { t: "changePasswordResponse"; success: boolean; error?: string; message?: string; forceLogout?: boolean };
