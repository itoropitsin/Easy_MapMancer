function drawWalls() {
  wallsLayer.clear();
  const seed = currentSeed || "demo-seed";
  const s = hashString(seed);
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  const color = 0x6b7280; // gray
  const revealed = levelId ? getRevealed(levelId) : undefined;
  for (let j = 0; j <= tilesY; j++) {
    for (let i = 0; i <= tilesX; i++) {
      const gx = startGX + i;
      const gy = startGY + j;
      const h = hash2D(gx, gy, s);
      // top edge
      if (
        (h & 0x1f) === 0 && isGround(gx, gy) && isGround(gx, gy - 1) &&
        !(myRole !== "DM" && revealed && (!revealed.has(`${gx},${gy}`) && !revealed.has(`${gx},${gy - 1}`)))
      ) {
        const x0 = gx * CELL, y0 = gy * CELL;
        wallsLayer.moveTo(x0, y0).lineTo(x0 + CELL, y0).stroke({ color, width: 2 });
      }
      // left edge
      if (
        ((h >>> 5) & 0x1f) === 0 && isGround(gx, gy) && isGround(gx - 1, gy) &&
        !(myRole !== "DM" && revealed && (!revealed.has(`${gx},${gy}`) && !revealed.has(`${gx - 1},${gy}`)))
      ) {
        const x0 = gx * CELL, y0 = gy * CELL;
        wallsLayer.moveTo(x0, y0).lineTo(x0, y0 + CELL).stroke({ color, width: 2 });
      }
    }
  }
}

function drawObjects() {
  // Placeholder decorative objects disabled by request
  objectsLayer.clear();
  return;
}

import { Application, Graphics, Container, Text, Circle, Rectangle } from "pixi.js";
import type {
  ID,
  Vec2,
  Token,
  Asset,
  FloorKind,
  Location,
  ServerToClient,
  ClientToServer,
  LocationTreeNode,
  Event,
  User,
  AuthState,
  GameSnapshot,
  FogMode,
  UserRole,
  HistoryEvent
} from "@dnd/shared";

// Small top-level toast helper for reuse outside connect()
function hudToast(text: string) {
  const hud = document.getElementById("hud");
  if (!hud) return;
  const el = document.createElement("div");
  el.textContent = text;
  el.style.opacity = "0.95";
  el.style.transition = "opacity 0.5s ease";
  hud.appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 600); }, 1400);
}

function uid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function escapeHtml(value: string | number | null | undefined): string {
  const str = String(value ?? "");
  return str.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return ch;
    }
  });
}

const CELL = 32;
let playerId: ID | null = null;
let myTokenId: ID | null = null;
let levelId: ID | null = null;
const tokens = new Map<ID, Token>();
type PendingTokenMove = { pos: Vec2; levelId: ID | null; timeoutId: number };
const pendingTokenMoves = new Map<ID, PendingTokenMove>();
const PENDING_TOKEN_MOVE_TTL_MS = 1200;

type StructuralFamily = "wall" | "window" | "door";

interface StructuralStyle {
  family: StructuralFamily;
  thickness?: number;
  fill?: number;
  stroke?: number;
  glass?: number;
  accent?: number;
}

interface StructuralStyleResolved {
  family: StructuralFamily;
  thickness: number;
  fill: number;
  stroke: number;
  glass: number;
  accent?: number;
}

const STRUCTURAL_DEFAULTS: Record<StructuralFamily, StructuralStyleResolved> = {
  wall: { family: "wall", thickness: 0.16, fill: 0x6b7280, stroke: 0x4b5563, glass: 0x60a5fa },
  window: { family: "window", thickness: 0.14, fill: 0x60a5fa, stroke: 0x1d4ed8, glass: 0x93c5fd },
  door: { family: "door", thickness: 0.18, fill: 0x8b5a2b, stroke: 0x5a3a1c, glass: 0x8b5a2b }
};

const STRUCTURAL_VARIANTS: Record<string, StructuralStyle> = {
  "wall-stone": { family: "wall", fill: 0x4b5563, stroke: 0x1f2937, thickness: 0.2 },
  "wall-wood": { family: "wall", fill: 0x9a6b3c, stroke: 0x5a3a1c, thickness: 0.18 },
  "wall-ruined": { family: "wall", fill: 0x7f8c8d, stroke: 0x3f4c4d, thickness: 0.12 },
  "window-stained": { family: "window", glass: 0xfb7185, stroke: 0x831843 },
  "window-barred": { family: "window", glass: 0x9ca3af, stroke: 0x1f2937 },
  "window-observation": { family: "window", glass: 0xbcd7ff, stroke: 0x2563eb, thickness: 0.1 },
  "door-iron": { family: "door", fill: 0x4b5563, stroke: 0x1f2937 },
  "door-arched": { family: "door", fill: 0xb45309, stroke: 0x78350f },
  "door-portcullis": { family: "door", fill: 0x374151, stroke: 0x111827 }
};

function inferStructuralFamily(kind: string | undefined): StructuralFamily | null {
  if (!kind) return null;
  if (kind === "wall" || kind === "window" || kind === "door") return kind;
  if (kind.startsWith("wall-")) return "wall";
  if (kind.startsWith("window-")) return "window";
  if (kind.startsWith("door-")) return "door";
  return null;
}

function getStructuralStyle(kind: string): StructuralStyleResolved | null {
  const preset = STRUCTURAL_VARIANTS[kind];
  const family = preset?.family ?? inferStructuralFamily(kind);
  if (!family) return null;
  const defaults = STRUCTURAL_DEFAULTS[family];
  return {
    family,
    thickness: preset?.thickness ?? defaults.thickness,
    fill: preset?.fill ?? defaults.fill,
    stroke: preset?.stroke ?? defaults.stroke,
    glass: preset?.glass ?? (preset?.fill ?? defaults.glass ?? defaults.fill),
    accent: preset?.accent ?? defaults.accent
  };
}

function hexToCss(value: number): string {
  const safe = Math.max(0, Math.min(0xffffff, value >>> 0));
  return `#${safe.toString(16).padStart(6, "0")}`;
}

function setPendingTokenMove(tokenId: ID, pos: Vec2, level: ID | null) {
  const existing = pendingTokenMoves.get(tokenId);
  if (existing) {
    window.clearTimeout(existing.timeoutId);
  }
  const timeoutId = window.setTimeout(() => {
    const pending = pendingTokenMoves.get(tokenId);
    if (!pending || pending.timeoutId !== timeoutId) return;
    pendingTokenMoves.delete(tokenId);
    drawTokens();
  }, PENDING_TOKEN_MOVE_TTL_MS);
  pendingTokenMoves.set(tokenId, { pos, levelId: level, timeoutId });
}

function resolvePendingTokenMove(tokenId: ID) {
  const pending = pendingTokenMoves.get(tokenId);
  if (!pending) return;
  window.clearTimeout(pending.timeoutId);
  pendingTokenMoves.delete(tokenId);
}

function clearPendingTokenMoves() {
  for (const pending of pendingTokenMoves.values()) {
    window.clearTimeout(pending.timeoutId);
  }
  pendingTokenMoves.clear();
}

let currentLocation: Location | null = null;
let currentSeed: string | null = null;
let myRole: "DM" | "PLAYER" | null = null;
let fogMode: FogMode = "automatic"; // fog of war reveal mode
const revealedByLevel: Map<ID, Set<string>> = new Map();
const assets = new Map<ID, Asset>();
type EditorMode = "cursor" | "paint" | "eraseObjects" | "eraseSpace" | "revealFog" | "eraseFog" | "eraseTokens" | "spawnToken";
let editorMode: EditorMode = "cursor";
const BRUSH_MODES: EditorMode[] = ["paint", "eraseObjects", "eraseSpace", "revealFog", "eraseFog"];
let selectedTokenId: ID | null = null;
let selectedAssetKind: string | null = null; // when null, floor tools may be used
let selectedFloorKind: FloorKind | null = null;
let selectedTokenKind: "player" | "npc" | null = null;

type RightPanelTab = "character" | "history";
const RIGHT_PANEL_TAB_KEY = "dnd_right_panel_tab";
function loadStoredRightPanelTab(): RightPanelTab {
  if (typeof window === "undefined") return "character";
  try {
    const stored = window.localStorage.getItem(RIGHT_PANEL_TAB_KEY);
    return stored === "history" ? "history" : "character";
  } catch {
    return "character";
  }
}
let rightPanelTab: RightPanelTab = loadStoredRightPanelTab();
let historyEvents: HistoryEvent[] = [];
const HISTORY_EVENT_LIMIT = 200;

function rerenderHistoryIfVisible() {
  if (rightPanelTab === "history") {
    renderRightPanel();
  }
}

// Authentication state
let authState: AuthState = { isAuthenticated: false };
let currentUser: User | null = null;
let logoutTimeout: ReturnType<typeof setTimeout> | null = null;
let createUserPending = false;
let pendingPasswordUserId: string | null = null;
let pendingPasswordUsername: string | null = null;
let userManagementInitialized = false;
let profileModalInitialized = false;
let profileChangePending = false;
let profileModalEl: HTMLElement | null = null;
let profileErrorEl: HTMLElement | null = null;
let profileCurrentInput: HTMLInputElement | null = null;
let profileNewInput: HTMLInputElement | null = null;
let profileConfirmInput: HTMLInputElement | null = null;
let profileSubmitBtn: HTMLButtonElement | null = null;

// Session management functions
function saveSession(user: User, token: string) {
  try {
    localStorage.setItem('dnd_session', JSON.stringify({ user, token, timestamp: Date.now() }));
    console.log("[DEBUG] Session saved to localStorage");
  } catch (error) {
    console.error("[DEBUG] Failed to save session:", error);
  }
}

function setRightPanelTab(tab: RightPanelTab) {
  rightPanelTab = tab;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(RIGHT_PANEL_TAB_KEY, tab);
    } catch {}
  }
  renderRightPanel();
}

function setHistoryEvents(events: HistoryEvent[]) {
  const seen = new Set<string>();
  const unique: HistoryEvent[] = [];
  for (let i = events.length - 1; i >= 0 && unique.length < HISTORY_EVENT_LIMIT; i--) {
    const ev = events[i]!;
    if (!seen.has(ev.id)) {
      seen.add(ev.id);
      unique.push(ev);
    }
  }
  historyEvents = unique.reverse();
  rerenderHistoryIfVisible();
}

function appendHistoryEvent(event: HistoryEvent) {
  if (historyEvents.some(ev => ev.id === event.id)) return;
  historyEvents = [...historyEvents, event].slice(-HISTORY_EVENT_LIMIT);
  rerenderHistoryIfVisible();
}

function loadSession(): { user: User; token: string } | null {
  try {
    const sessionData = localStorage.getItem('dnd_session');
    if (!sessionData) return null;
    
    const { user, token, timestamp } = JSON.parse(sessionData);
    
    // Check if session is not too old (24 hours)
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
    if (Date.now() - timestamp > maxAge) {
      console.log("[DEBUG] Session expired, clearing");
      clearSession();
      return null;
    }
    
    console.log("[DEBUG] Session loaded from localStorage");
    return { user, token };
  } catch (error) {
    console.error("[DEBUG] Failed to load session:", error);
    clearSession();
    return null;
  }
}

function clearSession() {
  try {
    localStorage.removeItem('dnd_session');
    console.log("[DEBUG] Session cleared from localStorage");
  } catch (error) {
    console.error("[DEBUG] Failed to clear session:", error);
  }
}

// Authentication functions
function showFirstUserScreen() {
  const firstUserScreen = document.getElementById('first-user-screen');
  const loginScreen = document.getElementById('login-screen');
  const mainApp = document.getElementById('main-app');
  if (firstUserScreen && loginScreen && mainApp) {
    firstUserScreen.style.display = 'flex';
    loginScreen.style.display = 'none';
    mainApp.style.display = 'none';
  }
}

const PASSWORD_TOGGLE_SHOW_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M12 5C7.03 5 2.84 8.11 1.18 12c1.66 3.89 5.85 7 10.82 7s9.16-3.11 10.82-7C21.16 8.11 16.97 5 12 5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <circle cx="12" cy="12" r="3" fill="currentColor"></circle>
  </svg>
`;

const PASSWORD_TOGGLE_HIDE_ICON = `
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path d="M4.53 4.53 19.47 19.47" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="M17.66 15.61C16.02 17.25 13.75 18.32 11.3 18.47c-4.27.27-8.11-2.33-10.12-6.47a13.14 13.14 0 0 1 4.03-4.87M15.14 15.07a3 3 0 0 1-4.21-4.21" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
    <path d="M21.82 12a13.45 13.45 0 0 0-4.03-4.87A9.39 9.39 0 0 0 12 5c-.49 0-.98.03-1.45.08" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>
`;

let loginPasswordToggleBound = false;

function updatePasswordToggleUI(passwordInput: HTMLInputElement, toggleBtn: HTMLButtonElement, maskPassword: boolean) {
  passwordInput.type = maskPassword ? 'password' : 'text';
  toggleBtn.innerHTML = maskPassword ? PASSWORD_TOGGLE_SHOW_ICON : PASSWORD_TOGGLE_HIDE_ICON;
  toggleBtn.setAttribute('aria-label', maskPassword ? 'Show password' : 'Hide password');
  toggleBtn.setAttribute('aria-pressed', maskPassword ? 'false' : 'true');
}

function resetLoginForm() {
  const loginForm = document.getElementById('login-form') as HTMLFormElement | null;
  if (!loginForm) return;

  const submitBtn = loginForm.querySelector('button[type="submit"]') as HTMLButtonElement | null;
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Login';
  }
  const passwordInput = document.getElementById('password') as HTMLInputElement | null;
  const togglePasswordBtn = document.getElementById('toggle-password') as HTMLButtonElement | null;
  if (passwordInput && togglePasswordBtn) {
    updatePasswordToggleUI(passwordInput, togglePasswordBtn, true);
  }
}

function showLoginScreen() {
  const firstUserScreen = document.getElementById('first-user-screen');
  const loginScreen = document.getElementById('login-screen');
  const mainApp = document.getElementById('main-app');
  if (firstUserScreen && loginScreen && mainApp) {
    firstUserScreen.style.display = 'none';
    loginScreen.style.display = 'flex';
    mainApp.style.display = 'none';
  }
  resetLoginForm();
}

function hideLoginScreen() {
  const firstUserScreen = document.getElementById('first-user-screen');
  const loginScreen = document.getElementById('login-screen');
  const mainApp = document.getElementById('main-app');
  if (firstUserScreen && loginScreen && mainApp) {
    firstUserScreen.style.display = 'none';
    loginScreen.style.display = 'none';
    mainApp.style.display = 'block';
  }
}

function showError(message: string) {
  const errorEl = document.getElementById('login-error');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }
}

function hideError() {
  const errorEl = document.getElementById('login-error');
  if (errorEl) {
    errorEl.style.display = 'none';
  }
}

function showFirstUserError(message: string) {
  const errorEl = document.getElementById('first-user-error');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }
}

function hideFirstUserError() {
  const errorEl = document.getElementById('first-user-error');
  if (errorEl) {
    errorEl.style.display = 'none';
  }
}

function setupLoginForm() {
  const loginForm = document.getElementById('login-form') as HTMLFormElement;
  if (!loginForm) return;

  // Setup password visibility toggle
  const togglePasswordBtn = document.getElementById('toggle-password') as HTMLButtonElement | null;
  const passwordInput = document.getElementById('password') as HTMLInputElement;
  if (togglePasswordBtn && passwordInput) {
    updatePasswordToggleUI(passwordInput, togglePasswordBtn, passwordInput.type === 'password');
    if (!loginPasswordToggleBound) {
      togglePasswordBtn.addEventListener('mousedown', (event) => event.preventDefault());
      togglePasswordBtn.addEventListener('click', () => {
        const shouldMask = passwordInput.type === 'text';
        updatePasswordToggleUI(passwordInput, togglePasswordBtn, shouldMask);
        passwordInput.focus();
      });
      loginPasswordToggleBound = true;
    }
  }

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(loginForm);
    const usernameOrEmailRaw = formData.get('usernameOrEmail') as string;
    const passwordRaw = formData.get('password') as string;
    const usernameOrEmail = (usernameOrEmailRaw || "").trim();
    const password = (passwordRaw || "").trim();

    if (!usernameOrEmail || !password) {
      showError('Please fill in all fields');
      return;
    }

    hideError();
    
    // Disable form during login
    const submitBtn = loginForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logging in...';

    try {
      // Store login data for WebSocket connection
      (window as any).pendingLogin = { usernameOrEmail, password };
      console.log("[DEBUG] Stored pending login:", { usernameOrEmail, password: "***" });
      
      // Check if WebSocket is already connected
      if (socket && socket.readyState === WebSocket.OPEN) {
        // Send login message directly
        const loginMsg: ClientToServer = { 
          t: "login", 
          data: { 
            usernameOrEmail, 
            password 
          } 
        };
        console.log("[DEBUG] Sending login message directly:", loginMsg);
        socket.send(JSON.stringify(loginMsg));
      } else {
        // Connect to WebSocket (will handle login)
        connect();
      }
    } catch (error) {
      showError('Login failed. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Login';
    }
  });
}

function setupFirstUserForm() {
  const firstUserForm = document.getElementById('first-user-form') as HTMLFormElement;
  if (!firstUserForm) return;

  firstUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const formData = new FormData(firstUserForm);
    const username = (formData.get('username') as string || "").trim();
    const email = (formData.get('email') as string || "").trim().toLowerCase();

    if (!username || !email) {
      showFirstUserError('Please fill in all fields');
      return;
    }

    hideFirstUserError();
    
    // Disable form during creation
    const submitBtn = firstUserForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';

    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          t: 'createFirstUser',
          data: { username, email }
        }));
      } else {
        showFirstUserError('Not connected to server');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create Master Account';
      }
    } catch (error) {
      showFirstUserError('Failed to create user');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create Master Account';
    }
  });
}

function setupUserManagement() {
  const usersPanel = document.getElementById('users-panel') as HTMLElement;
  const createUserBtn = document.getElementById('create-user-btn') as HTMLButtonElement;
  const createUserModal = document.getElementById('create-user-modal') as HTMLElement;
  const createUserForm = document.getElementById('create-user-form') as HTMLFormElement;
  const passwordModal = document.getElementById('password-modal') as HTMLElement;
  const usersCloseBtn = document.getElementById('users-close') as HTMLButtonElement | null;
  const resetPasswordModal = document.getElementById('reset-password-modal') as HTMLElement | null;
  const resetPasswordForm = document.getElementById('reset-password-form') as HTMLFormElement | null;
  const resetPasswordInput = document.getElementById('reset-password-input') as HTMLInputElement | null;
  const resetPasswordGenerate = document.getElementById('reset-password-generate') as HTMLButtonElement | null;
  const resetPasswordCancel = document.getElementById('reset-password-cancel') as HTMLButtonElement | null;
  const resetPasswordClose = document.getElementById('reset-password-close') as HTMLButtonElement | null;
  const resetPasswordSubmit = document.getElementById('reset-password-submit') as HTMLButtonElement | null;

  if (!usersPanel || !createUserBtn || !createUserModal || !createUserForm || !passwordModal || !resetPasswordModal || !resetPasswordForm || !resetPasswordInput || !resetPasswordSubmit) return;

  if (userManagementInitialized) return;
  userManagementInitialized = true;

  usersPanel.setAttribute('aria-hidden', usersPanel.classList.contains('open') ? 'false' : 'true');

  // Create user button
  createUserBtn.addEventListener('click', () => {
    createUserModal.style.display = 'flex';
  });

  // Close modals
  document.getElementById('create-user-close')?.addEventListener('click', () => {
    createUserModal.style.display = 'none';
  });

  document.getElementById('create-user-cancel')?.addEventListener('click', () => {
    createUserModal.style.display = 'none';
  });

  document.getElementById('password-close')?.addEventListener('click', () => {
    passwordModal.style.display = 'none';
  });

  document.getElementById('password-ok')?.addEventListener('click', () => {
    passwordModal.style.display = 'none';
  });

  const closeResetModal = () => {
    closeResetPasswordModal();
  };

  resetPasswordClose?.addEventListener('click', closeResetModal);
  resetPasswordCancel?.addEventListener('click', closeResetModal);

  resetPasswordGenerate?.addEventListener('click', (event) => {
    event.preventDefault();
    if (!resetPasswordInput) return;
    resetPasswordInput.value = generateClientPassword();
    resetPasswordInput.focus();
    resetPasswordInput.select();
  });

  resetPasswordForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!pendingPasswordUserId) {
      hudToast('Select a user first.');
      return;
    }
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      hudToast('Not connected to server.');
      return;
    }
    const password = resetPasswordInput.value.trim();
    if (resetPasswordSubmit) {
      resetPasswordSubmit.disabled = true;
      resetPasswordSubmit.textContent = 'Saving...';
    }
    socket.send(JSON.stringify({
      t: 'resetUserPassword',
      userId: pendingPasswordUserId,
      password: password.length ? password : undefined
    }));
  });

  resetPasswordModal.addEventListener('click', (event) => {
    if (event.target === resetPasswordModal) {
      closeResetPasswordModal();
    }
  });

  // Close admin panel
  if (usersCloseBtn) {
    usersCloseBtn.addEventListener('click', () => {
      closeUsersPanel();
    });
  }

  usersPanel.addEventListener('click', (event) => {
    if (event.target === usersPanel) {
      closeUsersPanel();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    const resetOpen = resetPasswordModal && resetPasswordModal.style.display === 'flex';
    if (resetOpen) {
      closeResetPasswordModal();
      return;
    }
    if (usersPanel.classList.contains('open')) {
      closeUsersPanel();
    }
  });

  // Create user form
  createUserForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (createUserPending) return;
    const formData = new FormData(createUserForm);
    const username = ((formData.get('username') as string) || "").trim();
    const email = ((formData.get('email') as string) || "").trim().toLowerCase();
    const role = ((formData.get('role') as string) || "user").trim();

    if (!username || !email) {
      showCreateUserError('Please fill in all fields');
      return;
    }

    hideCreateUserError();
    
    const submitBtn = createUserForm.querySelector('button[type="submit"]') as HTMLButtonElement;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Creating...';
    createUserPending = true;

    try {
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          t: 'createUser',
          data: { username, email, role }
        }));
      } else {
        showCreateUserError('Not connected to server');
        submitBtn.disabled = false;
        submitBtn.textContent = 'Create User';
      }
    } catch (error) {
      showCreateUserError('Failed to create user');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Create User';
      createUserPending = false;
    }
  });

}

function showCreateUserError(message: string) {
  const errorEl = document.getElementById('create-user-error');
  if (errorEl) {
    errorEl.textContent = message;
    errorEl.style.display = 'block';
  }
}

function hideCreateUserError() {
  const errorEl = document.getElementById('create-user-error');
  if (errorEl) {
    errorEl.style.display = 'none';
  }
}

function loadUsersList() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ t: 'listUsers' }));
  }
}

function renderUsersList(users: User[]) {
  const usersList = document.getElementById('users-list');
  if (!usersList) return;

  if (!users.length) {
    usersList.innerHTML = `
      <div class="user-empty">
        No users yet. Create an invite to bring players into your campaign.
      </div>
    `;
    return;
  }

  const currentUserId = currentUser?.id;
  const roleOptions: Array<{ value: UserRole; label: string }> = [
    { value: 'master', label: 'Master' },
    { value: 'user', label: 'Player' }
  ];

  usersList.innerHTML = users.map(user => {
    const isSelf = currentUserId === user.id;
    const safeName = escapeHtml(user.username);
    const safeEmail = escapeHtml(user.email);
    const roleSelect = roleOptions.map(option => `
        <option value="${option.value}"${option.value === user.role ? ' selected' : ''}>
          ${option.label}
        </option>
      `).join('');

    return `
      <div class="user-item" role="listitem" data-user-id="${user.id}">
        <div class="user-info">
          <div class="user-name">${safeName}</div>
          <div class="user-email">${safeEmail}</div>
        </div>
        <div class="user-role-control">
          <label class="user-role-label" for="role-${user.id}">Role</label>
          <select id="role-${user.id}" class="user-role-select" data-user-id="${user.id}"${isSelf ? ' disabled' : ''}>
            ${roleSelect}
          </select>
        </div>
        <div class="user-actions">
          <button class="user-action-btn reset" type="button" data-user-id="${user.id}" data-username="${safeName}">
            Set Password
          </button>
          <button class="user-action-btn danger delete" type="button" data-user-id="${user.id}"${isSelf ? ' disabled' : ''}>
            Delete
          </button>
        </div>
      </div>
    `;
  }).join('');

  const roleSelects = Array.from(usersList.querySelectorAll<HTMLSelectElement>('.user-role-select'));
  roleSelects.forEach(select => {
    select.addEventListener('change', () => {
      const userId = select.dataset.userId;
      const newRole = select.value as UserRole;
      if (!userId || !socket || socket.readyState !== WebSocket.OPEN) {
        hudToast('Unable to update role right now.');
        select.value = select.getAttribute('data-prev') || select.value;
        return;
      }
      select.disabled = true;
      socket.send(JSON.stringify({
        t: 'updateUserRole',
        userId,
        role: newRole
      }));
    });
    select.setAttribute('data-prev', select.value);
  });

  const resetButtons = Array.from(usersList.querySelectorAll<HTMLButtonElement>('.user-action-btn.reset'));
  resetButtons.forEach(button => {
    button.addEventListener('click', () => {
      const userId = button.dataset.userId;
      const username = button.dataset.username || '';
      if (userId) {
        openResetPasswordModal(userId, username);
      }
    });
  });

  const deleteButtons = Array.from(usersList.querySelectorAll<HTMLButtonElement>('.user-action-btn.delete'));
  deleteButtons.forEach(button => {
    button.addEventListener('click', () => {
      const userId = button.dataset.userId;
      if (!userId) return;
      confirmDeleteUser(userId);
    });
  });
}

function openUsersPanel() {
  const usersPanel = document.getElementById('users-panel');
  if (!usersPanel) return;

  usersPanel.classList.add('open');
  usersPanel.setAttribute('aria-hidden', 'false');
  document.body?.classList.add('users-panel-open');

  loadUsersList();
}

function closeUsersPanel() {
  const usersPanel = document.getElementById('users-panel');
  if (!usersPanel) return;

  usersPanel.classList.remove('open');
  usersPanel.setAttribute('aria-hidden', 'true');
  document.body?.classList.remove('users-panel-open');
  closeResetPasswordModal();
}

function confirmDeleteUser(userId: string) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    hudToast('Unable to contact server.');
    return;
  }
  if (currentUser && currentUser.id === userId) {
    hudToast("You can't delete your own account while logged in.");
    return;
  }
  if (confirm('Are you sure you want to delete this user?')) {
    socket.send(JSON.stringify({
      t: 'deleteUser',
      userId
    }));
  }
}

function showPasswordModal(username: string, password: string, context: "created" | "reset" = "created") {
  const passwordModal = document.getElementById('password-modal');
  const titleEl = document.getElementById('password-modal-title');
  const messageEl = document.getElementById('password-modal-message');
  const generatedPassword = document.getElementById('generated-password') as HTMLInputElement | null;
  if (!passwordModal || !titleEl || !messageEl || !generatedPassword) return;
  const safeUsername = escapeHtml(username);
  if (context === "created") {
    titleEl.textContent = "User Created Successfully";
    messageEl.innerHTML = `User <strong>${safeUsername}</strong> has been created successfully.`;
  } else {
    titleEl.textContent = "Password Updated";
    messageEl.innerHTML = `Password for <strong>${safeUsername}</strong> has been reset.`;
  }
  generatedPassword.value = password;
  passwordModal.style.display = 'flex';
  generatedPassword.focus();
  generatedPassword.select();
}

function generateClientPassword(length = 12): string {
  const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lowercase = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const symbols = "!@#$%^&*";
  const allChars = uppercase + lowercase + digits + symbols;

  const randomIndex = (max: number, fallback: number) => {
    if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
      const buffer = new Uint32Array(1);
      window.crypto.getRandomValues(buffer);
      return buffer[0] % max;
    }
    return fallback % max;
  };

  const ensureChar = (pool: string, fallback: number) => pool.charAt(randomIndex(pool.length, fallback));

  const passwordChars: string[] = [
    ensureChar(uppercase, 0),
    ensureChar(lowercase, 1),
    ensureChar(digits, 2),
    ensureChar(symbols, 3)
  ];

  while (passwordChars.length < length) {
    const fallback = Math.floor(Math.random() * allChars.length);
    passwordChars.push(allChars.charAt(randomIndex(allChars.length, fallback)));
  }

  for (let i = passwordChars.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, Math.floor(Math.random() * (i + 1)));
    const tmp = passwordChars[i];
    passwordChars[i] = passwordChars[j];
    passwordChars[j] = tmp;
  }

  return passwordChars.join("");
}

function openResetPasswordModal(userId: string, username: string) {
  const modal = document.getElementById('reset-password-modal');
  const nameField = document.getElementById('reset-password-username');
  const input = document.getElementById('reset-password-input') as HTMLInputElement | null;
  const submitBtn = document.getElementById('reset-password-submit') as HTMLButtonElement | null;
  if (!modal || !nameField || !input || !submitBtn) return;
  pendingPasswordUserId = userId;
  pendingPasswordUsername = username;
  nameField.textContent = username;
  input.value = "";
  input.focus();
  submitBtn.disabled = false;
  submitBtn.textContent = 'Set Password';
  modal.style.display = 'flex';
}

function closeResetPasswordModal() {
  const modal = document.getElementById('reset-password-modal');
  if (modal) {
    modal.style.display = 'none';
  }
  const input = document.getElementById('reset-password-input') as HTMLInputElement | null;
  if (input) input.value = "";
  const submitBtn = document.getElementById('reset-password-submit') as HTMLButtonElement | null;
  if (submitBtn) {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Set Password';
  }
  pendingPasswordUserId = null;
  pendingPasswordUsername = null;
}

function clearProfileError() {
  if (profileErrorEl) {
    profileErrorEl.textContent = '';
    profileErrorEl.style.display = 'none';
  }
}

function showProfileError(message: string) {
  if (!profileErrorEl) return;
  profileErrorEl.textContent = message;
  profileErrorEl.style.display = 'block';
}

function resetProfileForm() {
  profileChangePending = false;
  if (profileCurrentInput) profileCurrentInput.value = "";
  if (profileNewInput) profileNewInput.value = "";
  if (profileConfirmInput) profileConfirmInput.value = "";
  if (profileSubmitBtn) {
    profileSubmitBtn.disabled = false;
    profileSubmitBtn.textContent = 'Update Password';
  }
  clearProfileError();
}

function closeProfileModal() {
  if (!profileModalEl) profileModalEl = document.getElementById('profile-modal') as HTMLElement | null;
  if (profileModalEl) {
    profileModalEl.style.display = 'none';
  }
  resetProfileForm();
}

function openProfileModal() {
  setupProfileModal();
  if (!profileModalEl || !currentUser) return;

  const usernameEl = document.getElementById('profile-display-username');
  const emailEl = document.getElementById('profile-display-email');
  const roleEl = document.getElementById('profile-display-role');
  if (usernameEl) usernameEl.textContent = currentUser.username;
  if (emailEl) emailEl.textContent = currentUser.email;
  if (roleEl) roleEl.textContent = currentUser.role === 'master' ? 'Master' : 'Player';

  resetProfileForm();
  profileModalEl.style.display = 'flex';
  profileCurrentInput?.focus();
}

function setupProfileModal() {
  if (profileModalInitialized) return;

  profileModalEl = document.getElementById('profile-modal');
  profileErrorEl = document.getElementById('profile-error');
  profileCurrentInput = document.getElementById('profile-current-password') as HTMLInputElement | null;
  profileNewInput = document.getElementById('profile-new-password') as HTMLInputElement | null;
  profileConfirmInput = document.getElementById('profile-confirm-password') as HTMLInputElement | null;
  profileSubmitBtn = document.getElementById('profile-password-submit') as HTMLButtonElement | null;
  const profileCloseBtn = document.getElementById('profile-close');
  const profileCancelBtn = document.getElementById('profile-cancel');
  const profileForm = document.getElementById('profile-form') as HTMLFormElement | null;

  if (!profileModalEl || !profileForm || !profileCurrentInput || !profileNewInput || !profileConfirmInput || !profileSubmitBtn) {
    console.warn('[Profile] Missing elements for profile modal setup');
    return;
  }

  profileModalInitialized = true;

  const handleClose = () => closeProfileModal();
  profileCloseBtn?.addEventListener('click', handleClose);
  profileCancelBtn?.addEventListener('click', handleClose);

  profileModalEl.addEventListener('click', (event) => {
    if (event.target === profileModalEl) {
      closeProfileModal();
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && profileModalEl.style.display === 'flex') {
      closeProfileModal();
    }
  });

  profileForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      showProfileError('Not connected to server.');
      return;
    }
    if (!currentUser) {
      showProfileError('You must be logged in to change your password.');
      return;
    }
    if (profileChangePending) return;

    const currentPassword = profileCurrentInput!.value.trim();
    const newPassword = profileNewInput!.value.trim();
    const confirmPassword = profileConfirmInput!.value.trim();

    clearProfileError();

    if (!currentPassword || !newPassword || !confirmPassword) {
      showProfileError('Please fill in all password fields.');
      return;
    }
    if (newPassword !== confirmPassword) {
      showProfileError('New passwords do not match.');
      return;
    }
    if (newPassword.length < 12) {
      showProfileError('New password must be at least 12 characters long.');
      return;
    }
    if (newPassword === currentPassword) {
      showProfileError('New password must be different from the current password.');
      return;
    }

    profileChangePending = true;
    if (profileSubmitBtn) {
      profileSubmitBtn.disabled = true;
      profileSubmitBtn.textContent = 'Updating...';
    }

    socket.send(JSON.stringify({
      t: 'changeOwnPassword',
      data: {
        currentPassword,
        newPassword
      }
    }));
  });
}
let painting = false;
let lastPaintKey: string | null = null;
let lastPaintCell: Vec2 | null = null;
let brushSize: 1 | 2 | 3 | 4 = 1;
let locationsExpanded = new Set<string>();
let lastUsedLocationPath: string | undefined;
const SHARE_BASE_URL = typeof window !== "undefined" ? window.location.origin : "";
// Recent locations (client-side only)
let recentLocations: string[] = [];
try { const s = localStorage.getItem("recentLocations"); if (s) recentLocations = JSON.parse(s); } catch {}

// Starred locations (client-side only)
let starredLocations: string[] = [];
try { const s = localStorage.getItem("starredLocations"); if (s) starredLocations = JSON.parse(s); } catch {}

// Available character icons shared between players and NPCs
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
function saveRecents() { try { localStorage.setItem("recentLocations", JSON.stringify(recentLocations.slice(0, 10))); } catch {} }
function saveStarred() { try { localStorage.setItem("starredLocations", JSON.stringify(starredLocations)); } catch {} }

function addRecent(path: string | undefined) {
  if (!path) return;
  recentLocations = [path, ...recentLocations.filter(p => p !== path)].slice(0, 10);
  saveRecents();
}

function toggleStarred(path: string) {
  console.log(`[DEBUG] toggleStarred called with path:`, path);
  console.log(`[DEBUG] Current starred locations:`, starredLocations);
  const idx = starredLocations.indexOf(path);
  if (idx >= 0) {
    starredLocations.splice(idx, 1);
    console.log(`[DEBUG] Removed from starred:`, path);
  } else {
    starredLocations.push(path);
    console.log(`[DEBUG] Added to starred:`, path);
  }
  saveStarred();
  console.log(`[DEBUG] New starred locations:`, starredLocations);
  // Refresh the locations tree to update star states
  requestLocationsList();
}

function isStarred(path: string): boolean {
  return starredLocations.includes(path);
}

function requestLocationsList() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const msg: ClientToServer = { t: "listLocations" };
  socket.send(JSON.stringify(msg));
}
// Track whether the last pointerdown actually applied an action (to avoid duplicate pointertap handling)
let lastPointerDownDidAct = false;

function brushCells(center: Vec2, size: 1 | 2 | 3 | 4): Vec2[] {
  // Centered brush: for even sizes, bias towards top-left
  const half = Math.floor(size / 2);
  const cells: Vec2[] = [];
  for (let dy = -half; dy < size - half; dy++) {
    for (let dx = -half; dx < size - half; dx++) {
      const gx = center.x + dx; const gy = center.y + dy;
      // No hard bounds: allow painting anywhere; server validates usage via recorded floor overrides
      cells.push({ x: gx, y: gy });
    }
  }
  return cells;
}

function resolveActiveLevel(): ID | null {
  return levelId || (currentLocation?.levels?.[0]?.id as ID | undefined) || null;
}

type BrushResult = { acted: boolean; touchedFloor: boolean };

function cellsBetween(a: Vec2, b: Vec2): Vec2[] {
  const out: Vec2[] = [];
  let x = a.x;
  let y = a.y;
  const dx = Math.abs(b.x - a.x);
  const dy = Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1;
  const sy = a.y < b.y ? 1 : -1;
  let err = dx - dy;
  while (x !== b.x || y !== b.y) {
    const e2 = err * 2;
    if (e2 > -dy) { err -= dy; x += sx; }
    if (e2 < dx) { err += dx; y += sy; }
    out.push({ x, y });
  }
  return out;
}

function applyBrushAtCell(cell: Vec2): BrushResult {
  let acted = false;
  let touchedFloor = false;
  const cells = brushCells(cell, brushSize);
  if (editorMode === "paint") {
    const lvl = resolveActiveLevel();
    if (!lvl) return { acted, touchedFloor };
    if (!levelId) levelId = lvl;
    for (const c of cells) {
      if (selectedFloorKind) {
        setFloorOverride(lvl, c, selectedFloorKind);
        touchedFloor = true;
        acted = true;
        if (socket && socket.readyState === WebSocket.OPEN) {
          const msg: ClientToServer = { t: "paintFloor", levelId: lvl, pos: c, kind: selectedFloorKind };
          socket.send(JSON.stringify(msg));
        }
      } else if (socket && socket.readyState === WebSocket.OPEN) {
        const kind = selectedAssetKind ?? "tree";
        const msg: ClientToServer = { t: "placeAsset", levelId: lvl, pos: c, kind };
        socket.send(JSON.stringify(msg));
        acted = true;
      }
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "eraseObjects") {
    const lvl = resolveActiveLevel();
    if (!socket || !lvl || socket.readyState !== WebSocket.OPEN) return { acted, touchedFloor };
    for (const c of cells) {
      const msg: ClientToServer = { t: "removeAssetAt", levelId: lvl, pos: c };
      socket.send(JSON.stringify(msg));
      acted = true;
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "eraseSpace") {
    const lvl = resolveActiveLevel();
    if (!lvl) return { acted, touchedFloor };
    for (const c of cells) {
      if (socket && socket.readyState === WebSocket.OPEN) {
        const rm: ClientToServer = { t: "removeAssetAt", levelId: lvl, pos: c };
        socket.send(JSON.stringify(rm));
      }
      setFloorOverride(lvl, c, null);
      touchedFloor = true;
      acted = true;
      if (socket && socket.readyState === WebSocket.OPEN) {
        const fl: ClientToServer = { t: "paintFloor", levelId: lvl, pos: c, kind: null };
        socket.send(JSON.stringify(fl));
      }
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "revealFog") {
    if (socket && socket.readyState === WebSocket.OPEN && levelId) {
      const msg: ClientToServer = { t: "revealFog", levelId, cells };
      socket.send(JSON.stringify(msg));
      acted = true;
    }
    return { acted, touchedFloor };
  }
  if (editorMode === "eraseFog") {
    if (socket && socket.readyState === WebSocket.OPEN && levelId) {
      const msg: ClientToServer = { t: "obscureFog", levelId, cells };
      socket.send(JSON.stringify(msg));
      acted = true;
    }
    return { acted, touchedFloor };
  }
  return { acted, touchedFloor };
}

// floors overrides, by levelId -> key -> kind
const floorsByLevel: Map<ID, Map<string, FloorKind>> = new Map();
function getFloors(level: ID): Map<string, FloorKind> {
  let m = floorsByLevel.get(level);
  if (!m) { m = new Map(); floorsByLevel.set(level, m); }
  return m;
}
function getFloorOverride(gx: number, gy: number): FloorKind | null {
  if (!levelId) return null;
  const k = `${gx},${gy}`;
  return getFloors(levelId).get(k) ?? null;
}
function setFloorOverride(level: ID, pos: Vec2, kind: FloorKind | null) {
  const m = getFloors(level);
  const k = `${pos.x},${pos.y}`;
  if (kind == null) m.delete(k); else m.set(k, kind);
}

const app = new Application();
await app.init({ 
  background: "#0b0e13", 
  antialias: false,  // Отключаем сглаживание для четкого отображения пиксельной графики
  resolution: window.devicePixelRatio || 1,  // Используем нативное разрешение экрана
  resizeTo: window 
});
document.getElementById("app")!.appendChild(app.canvas);

// Minimap setup - will be initialized in connect()
let minimapCanvas: HTMLCanvasElement | null = null;
let minimapCtx: CanvasRenderingContext2D | null = null;
let minimapViewport: HTMLElement | null = null;

// Prevent browser's default context menu on the canvas
app.canvas.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

// Prevent browser navigation gestures on trackpad
app.canvas.addEventListener("gesturestart", (e) => {
  e.preventDefault();
});

app.canvas.addEventListener("gesturechange", (e) => {
  e.preventDefault();
});

app.canvas.addEventListener("gestureend", (e) => {
  e.preventDefault();
});

// Prevent swipe navigation gestures
app.canvas.addEventListener("touchstart", (e) => {
  e.preventDefault();
}, { passive: false });

app.canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
}, { passive: false });

app.canvas.addEventListener("touchend", (e) => {
  e.preventDefault();
}, { passive: false });

// Additional protection against browser navigation
app.canvas.addEventListener("wheel", (e) => {
  // Prevent browser back/forward navigation on horizontal scroll
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault();
  }
}, { passive: false });

// Prevent browser navigation on key combinations
document.addEventListener("keydown", (e) => {
  // Prevent Alt+Left/Right navigation
  if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
    e.preventDefault();
  }
});

const world = new Container();
world.sortableChildren = true;
app.stage.addChild(world);
// UI overlay layer (not scaled)
const uiLayer = new Container();
// @ts-ignore
uiLayer.eventMode = "passive"; // allow children to receive events
app.stage.addChild(uiLayer);
// Enable pointer events on stage for drag tracking
// Pixi v8: set eventMode to receive interaction events
// @ts-ignore - eventMode exists in Pixi v8 types
(app.stage as any).eventMode = "static";
const stageHitArea = new Rectangle(0, 0, app.screen.width, app.screen.height);
app.stage.hitArea = stageHitArea;
function updateStageHitArea() {
  stageHitArea.width = app.screen.width;
  stageHitArea.height = app.screen.height;
}

// Floor layer
const floor = new Graphics();
world.addChild(floor);

// Grid layer
const grid = new Graphics();
world.addChild(grid);

// Fog-of-war layer (per-cell tiles)
const fogLayer = new Container();
const fogTiles = new Graphics();
fogLayer.addChild(fogTiles);
fogLayer.zIndex = 1000; // overlay above tokens
// ensure fog does not block pointer events
// @ts-ignore Pixi v8 event model
fogLayer.eventMode = "none";

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

// Wall sampling mirrors drawWalls():
// top edge at (gx, gy) if (hash2D(gx, gy, s) & 0x1f) === 0
// left edge at (gx, gy) if ((hash2D(gx, gy, s) >>> 5) & 0x1f) === 0
function wallSeed(): number { return hashString(currentSeed || "demo-seed"); }
function hasTopWall(gx: number, gy: number): boolean {
  const h = hash2D(gx, gy, wallSeed());
  return (h & 0x1f) === 0;
}
function hasLeftWall(gx: number, gy: number): boolean {
  const h = hash2D(gx, gy, wallSeed());
  return ((h >>> 5) & 0x1f) === 0;
}
function blockedBetween(a: Vec2, b: Vec2): boolean {
  if (a.x === b.x && a.y === b.y) return false;
  // helper: dynamic blocking by assets (walls and closed doors only)
  const isBlockingAssetAt = (gx: number, gy: number) => {
    for (const a of assets.values()) {
      if (a.levelId !== levelId) continue;
      if (a.pos.x === gx && a.pos.y === gy) {
        const family = inferStructuralFamily(a.kind);
        if (family === "wall") return true;
        if (family === "door" && (a as any).open !== true) return true;
      }
    }
    return false;
  };
  // Horizontal edge between (a) and (b=a+1,0)
  if (b.x === a.x + 1 && b.y === a.y) return hasLeftWall(b.x, b.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  if (b.x === a.x - 1 && b.y === a.y) return hasLeftWall(a.x, a.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  // Vertical edge between (a) and (b=a+0,1)
  if (b.y === a.y + 1 && b.x === a.x) return hasTopWall(a.x, b.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  if (b.y === a.y - 1 && b.x === a.x) return hasTopWall(a.x, a.y) || isBlockingAssetAt(a.x, a.y) || isBlockingAssetAt(b.x, b.y);
  // Diagonals considered blocked for LOS flood
  return true;
}

function cellsLOS(center: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  const q: Vec2[] = [];
  const seen = new Set<string>();
  const r2 = r * r;
  if (!isGround(center.x, center.y)) return out;
  function push(v: Vec2) {
    const k = cellKey(v);
    if (seen.has(k)) return;
    seen.add(k);
    q.push(v);
    out.push(v);
  }
  push(center);
  while (q.length) {
    const v = q.shift()!;
    const neigh: Vec2[] = [
      { x: v.x + 1, y: v.y },
      { x: v.x - 1, y: v.y },
      { x: v.x, y: v.y + 1 },
      { x: v.x, y: v.y - 1 },
    ];
    for (const n of neigh) {
      if (!isGround(n.x, n.y)) continue;
      const dx = n.x - center.x, dy = n.y - center.y;
      if (dx * dx + dy * dy > r2) continue;
      if (blockedBetween(v, n)) continue;
      push(n);
    }
  }
  return out;
}

function tileColor(gx: number, gy: number, seedStr: string): number {
  const s = hashString(seedStr);
  const n = hash2D(gx, gy, s) & 255; // 0..255
  // Map to two-tone stone floor
  const t = n / 255;
  const base = 0x2b2f36; // dark slate
  const light = 0x39424e; // lighter slate
  // checker weight to avoid banding
  const mix = ((gx ^ gy) & 1) ? t * 0.35 + 0.35 : t * 0.25 + 0.25;
  const r = ((base >> 16) & 0xff) * (1 - mix) + ((light >> 16) & 0xff) * mix;
  const g = ((base >> 8) & 0xff) * (1 - mix) + ((light >> 8) & 0xff) * mix;
  const b = (base & 0xff) * (1 - mix) + (light & 0xff) * mix;
  return ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
}

type FloorPalette = { light: number; mid: number; dark: number };
const PAINTED_FLOOR_PALETTES: Record<FloorKind, FloorPalette> = {
  stone: { light: 0x7a808a, mid: 0x6b7280, dark: 0x5c6470 },
  wood: { light: 0x9c6b2b, mid: 0x8b5a2b, dark: 0x7a492b },
  water: { light: 0x4a9cf0, mid: 0x3b82f6, dark: 0x2c68dc },
  sand: { light: 0xd9c398, mid: 0xd1b892, dark: 0xc9ad8c },
  grass: { light: 0x52b14d, mid: 0x3f8f3e, dark: 0x2c6d2f },
  path: { light: 0x7b6345, mid: 0x6b5b47, dark: 0x5b5349 },
  bridge: { light: 0x7b4a1b, mid: 0x70421f, dark: 0x653a23 },
  carpet: { light: 0xd42626, mid: 0xb91c1c, dark: 0x9e1212 },
  marble: { light: 0xf0f2f4, mid: 0xe2e8f0, dark: 0xd4dae2 },
  dirt: { light: 0x82380e, mid: 0x78350f, dark: 0x6e3210 },
  mud: { light: 0x6c2512, mid: 0x5c1d0a, dark: 0x4c1508 },
  snow: { light: 0xf0f2f4, mid: 0xe2e8f0, dark: 0xd4dae2 },
  ice: { light: 0xafc5ee, mid: 0x93c5fd, dark: 0x77a5cc },
};

function lerpChannel(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = lerpChannel(ar, br, t);
  const g = lerpChannel(ag, bg, t);
  const bch = lerpChannel(ab, bb, t);
  return (r << 16) | (g << 8) | bch;
}

function paintedFloorColor(kind: FloorKind, gx: number, gy: number): number {
  const palette = PAINTED_FLOOR_PALETTES[kind];
  if (!palette) return 0xffffff;
  const levelSeed = levelId ? hashString(levelId) : 0;
  const baseSeed = hashString(`${currentSeed || "demo-seed"}:${kind}`);
  const noise = hash2D(gx, gy, baseSeed ^ levelSeed);
  const mixT = ((noise >>> 1) & 0xff) / 255; // 0..1
  const mix = 0.2 + mixT * 0.35; // keep near mid tone
  const useLight = (noise & 1) === 0;
  let baseColor = useLight ? lerpColor(palette.mid, palette.light, mix) : lerpColor(palette.mid, palette.dark, mix);
  
  // Add texture based on floor type
  const textureNoise = hash2D(gx, gy, baseSeed ^ levelSeed ^ 0x12345678);
  const texturePattern = (textureNoise >>> 8) & 0xff;
  
  switch (kind) {
    case 'stone':
      // Stone texture: add small dark spots
      if ((texturePattern & 0x1f) < 3) {
        baseColor = lerpColor(baseColor, 0x404040, 0.3);
      }
      break;
    case 'wood':
      // Wood texture: add grain lines
      if ((texturePattern & 0x0f) < 2) {
        baseColor = lerpColor(baseColor, 0x2d1b0e, 0.2);
      }
      break;
    case 'water':
      // Water texture: add ripples
      if ((texturePattern & 0x1f) < 4) {
        baseColor = lerpColor(baseColor, 0x1e3a8a, 0.15);
      }
      break;
    case 'sand':
      // Sand texture: add small particles
      if ((texturePattern & 0x3f) < 6) {
        baseColor = lerpColor(baseColor, 0xfbbf24, 0.1);
      }
      break;
    case 'grass':
      // Grass texture: add small dark spots
      if ((texturePattern & 0x1f) < 3) {
        baseColor = lerpColor(baseColor, 0x166534, 0.2);
      }
      break;
    case 'path':
      // Path texture: add dirt spots
      if ((texturePattern & 0x1f) < 4) {
        baseColor = lerpColor(baseColor, 0x451a03, 0.25);
      }
      break;
    case 'bridge':
      // Bridge texture: add wood grain
      if ((texturePattern & 0x0f) < 2) {
        baseColor = lerpColor(baseColor, 0x451a03, 0.2);
      }
      break;
    case 'carpet':
      // Carpet texture: add fabric pattern
      if ((texturePattern & 0x1f) < 3) {
        baseColor = lerpColor(baseColor, 0x7f1d1d, 0.15);
      }
      break;
    case 'marble':
      // Marble texture: add veining
      if ((texturePattern & 0x1f) < 2) {
        baseColor = lerpColor(baseColor, 0x94a3b8, 0.1);
      }
      break;
    case 'dirt':
      // Dirt texture: add small rocks
      if ((texturePattern & 0x1f) < 5) {
        baseColor = lerpColor(baseColor, 0x451a03, 0.2);
      }
      break;
    case 'mud':
      // Mud texture: add wet spots
      if ((texturePattern & 0x1f) < 4) {
        baseColor = lerpColor(baseColor, 0x1c1917, 0.25);
      }
      break;
    case 'snow':
      // Snow texture: add ice crystals
      if ((texturePattern & 0x1f) < 3) {
        baseColor = lerpColor(baseColor, 0xe0e7ff, 0.1);
      }
      break;
    case 'ice':
      // Ice texture: add cracks
      if ((texturePattern & 0x1f) < 2) {
        baseColor = lerpColor(baseColor, 0x1e40af, 0.15);
      }
      break;
  }
  
  return baseColor;
}

// 10x10 irregular island mask around (0..9, 0..9)
const ENABLE_PROCEDURAL_LAND = false;
function isLand(gx: number, gy: number): boolean {
  if (!ENABLE_PROCEDURAL_LAND) return false;
  if (gx < 0 || gx >= 10 || gy < 0 || gy >= 10) return false;
  const s = (hashString(currentSeed || "demo-seed") ^ 0xa5a5a5a5) >>> 0;
  const edge = Math.min(gx, gy, 9 - gx, 9 - gy);
  // carve edges a bit for an irregular outline
  if (edge === 0) {
    const h = hash2D(gx, gy, s);
    if ((h & 0xff) < 50) return false; // ~20% edge notches
  } else if (edge === 1) {
    const h = hash2D(gx * 3 + 7, gy * 5 + 11, s);
    if ((h & 0xff) < 20) return false; // subtle bays near edge
  }
  return true;
}

// treat either natural land or painted floor as ground
function isGround(gx: number, gy: number): boolean {
  return isLand(gx, gy) || !!getFloorOverride(gx, gy);
}

function getVisibleBounds() {
  const s = world.scale.x || 1;
  const topLeftX = (-world.position.x) / s;
  const topLeftY = (-world.position.y) / s;
  const viewW = app.screen.width / s;
  const viewH = app.screen.height / s;
  const startGX = Math.floor(topLeftX / CELL) - 1;
  const startGY = Math.floor(topLeftY / CELL) - 1;
  const tilesX = Math.ceil(viewW / CELL) + 3;
  const tilesY = Math.ceil(viewH / CELL) + 3;
  return { startGX, startGY, tilesX, tilesY };
}

function drawFloor() {
  floor.clear();
  const seed = currentSeed || "demo-seed";
  const revealed = levelId ? getRevealed(levelId) : undefined;
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  // Draw starry background on non-land tiles + floor on land tiles
  const sStars = hashString(seed + "*stars");
  for (let j = 0; j < tilesY; j++) {
    for (let i = 0; i < tilesX; i++) {
      const gx = startGX + i;
      const gy = startGY + j;
      const x = gx * CELL, y = gy * CELL;
      const k = `${gx},${gy}`;
      // PLAYER: show pure background on unrevealed ground (draw nothing here)
      if (myRole !== "DM" && revealed && isGround(gx, gy) && !revealed.has(k)) {
        continue;
      }
      // If an override exists, always render a floor tile (creates new land)
      const ov = getFloorOverride(gx, gy);
      if (ov) {
        const col = paintedFloorColor(ov, gx, gy);
        floor.rect(x, y, CELL, CELL).fill(col);
      } else if (isLand(gx, gy)) {
        const color = tileColor(gx, gy, seed);
        floor.rect(x, y, CELL, CELL).fill(color);
      } else {
        const h = hash2D(gx, gy, sStars);
        // a few small stars per some tiles
        if ((h & 0xff) < 8) {
          const ox = ((h >>> 8) & 31) / 31 * CELL;
          const oy = ((h >>> 13) & 31) / 31 * CELL;
          const r = 0.8 + (((h >>> 18) & 3) * 0.4);
          floor.circle(x + ox, y + oy, r).fill({ color: 0xffffff, alpha: 0.85 });
        }
        if (((h >>> 21) & 0xff) < 6) {
          const ox = ((h >>> 29) & 31) / 31 * CELL;
          const oy = ((h >>> 3) & 31) / 31 * CELL;
          const r = 0.6 + (((h >>> 10) & 3) * 0.3);
          floor.circle(x + ox, y + oy, r).fill({ color: 0xbfdfff, alpha: 0.6 });
        }
      }
    }
  }
}

function drawGrid() {
  grid.clear();
  grid.alpha = 0.35;
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  const revealed = levelId ? getRevealed(levelId) : undefined;
  if (myRole === "DM") {
    // DM: regular full-cell grid
    for (let j = 0; j < tilesY; j++) {
      for (let i = 0; i < tilesX; i++) {
        const gx = startGX + i;
        const gy = startGY + j;
        if (!isGround(gx, gy)) continue;
        grid.rect(gx * CELL, gy * CELL, CELL, CELL).stroke({ color: 0x4a5564, width: 1 });
      }
    }
  } else {
    // PLAYER: draw only internal lines between two revealed ground cells (no outer contour)
    const col = 0x4a5564;
    for (let j = 0; j < tilesY; j++) {
      for (let i = 0; i < tilesX; i++) {
        const gx = startGX + i;
        const gy = startGY + j;
        if (!isGround(gx, gy)) continue;
        if (!revealed || !revealed.has(`${gx},${gy}`)) continue;
        const x = gx * CELL, y = gy * CELL;
        // right neighbor
        if (isGround(gx + 1, gy) && revealed.has(`${gx + 1},${gy}`)) {
          grid.moveTo(x + CELL, y);
          grid.lineTo(x + CELL, y + CELL).stroke({ color: col, width: 1 });
        }
        // bottom neighbor
        if (isGround(gx, gy + 1) && revealed.has(`${gx},${gy + 1}`)) {
          grid.moveTo(x, y + CELL);
          grid.lineTo(x + CELL, y + CELL).stroke({ color: col, width: 1 });
        }
      }
    }
  }
}

drawFloor();
drawGrid();
drawFog();
drawMinimap();
window.addEventListener("resize", () => {
  updateStageHitArea();
  drawFloor();
  drawGrid();
  drawWalls();
  drawObjects();
  drawAssets();
  drawFog();
  drawMinimap();
});

// Walls & objects layers
const wallsLayer = new Graphics();
wallsLayer.zIndex = 200;
world.addChild(wallsLayer);
const objectsLayer = new Graphics();
objectsLayer.zIndex = 300;
world.addChild(objectsLayer);

// Unified layer for all game objects (tokens + assets) to allow z-index sorting between them
const gameObjectsLayer = new Container();
gameObjectsLayer.zIndex = 400;
gameObjectsLayer.sortableChildren = true;
world.addChild(gameObjectsLayer);

// place fog layer after game objects
world.addChild(fogLayer);

// Tokens that the local user can control are drawn above fog
const myTokensLayer = new Container();
myTokensLayer.zIndex = 1100;
myTokensLayer.sortableChildren = true;
world.addChild(myTokensLayer);

// Legacy layers (kept for compatibility but not used for new rendering)
const tokenLayer = new Container();
const assetsLayer = new Container();

// Now that layers exist, draw static content
drawWalls();
drawObjects();

// Minimap functions
function drawMinimap() {
  console.log("[MINIMAP] drawMinimap called");
  if (!minimapCanvas || !minimapCtx) {
    console.log("[MINIMAP] Canvas or context not found");
    return;
  }
  
  const canvasWidth = minimapCanvas.width;
  const canvasHeight = minimapCanvas.height;
  
  // Clear canvas
  minimapCtx.fillStyle = "#0b0e13";
  minimapCtx.fillRect(0, 0, canvasWidth, canvasHeight);
  
  if (!levelId) return;
  
  // Calculate minimap bounds (show a larger area than current view)
  const mapSize = 50; // Show 50x50 tiles
  const tileSize = Math.min(canvasWidth / mapSize, canvasHeight / mapSize);
  const offsetX = (canvasWidth - mapSize * tileSize) / 2;
  const offsetY = (canvasHeight - mapSize * tileSize) / 2;
  
  // Draw floor tiles
  const seed = currentSeed || "demo-seed";
  const revealed = getRevealed(levelId);
  
  for (let gy = 0; gy < mapSize; gy++) {
    for (let gx = 0; gx < mapSize; gx++) {
      const worldGx = gx - mapSize / 2;
      const worldGy = gy - mapSize / 2;
      
      // Check if tile should be visible
      if (myRole !== "DM" && revealed && isGround(worldGx, worldGy) && !revealed.has(`${worldGx},${worldGy}`)) {
        continue;
      }
      
      const x = offsetX + gx * tileSize;
      const y = offsetY + gy * tileSize;
      
      // Draw floor
      const ov = getFloorOverride(worldGx, worldGy);
      if (ov) {
        const col = paintedFloorColor(ov, worldGx, worldGy);
        minimapCtx.fillStyle = `#${col.toString(16).padStart(6, '0')}`;
        minimapCtx.fillRect(x, y, tileSize, tileSize);
      } else if (isLand(worldGx, worldGy)) {
        const color = tileColor(worldGx, worldGy, seed);
        minimapCtx.fillStyle = `#${color.toString(16).padStart(6, '0')}`;
        minimapCtx.fillRect(x, y, tileSize, tileSize);
      }
      
      // Draw walls
      if (isGround(worldGx, worldGy)) {
        minimapCtx.fillStyle = "#6b7280";
        minimapCtx.fillRect(x, y, tileSize, tileSize);
      }
    }
  }
  
  // Draw tokens
  for (const token of tokens.values()) {
    if (token.levelId !== levelId) continue;
    if (myRole !== "DM" && revealed && !revealed.has(`${token.pos.x},${token.pos.y}`)) continue;
    
    const x = offsetX + (token.pos.x + mapSize / 2) * tileSize;
    const y = offsetY + (token.pos.y + mapSize / 2) * tileSize;
    
    if (x >= 0 && x < canvasWidth && y >= 0 && y < canvasHeight) {
      // Определяем тип токена по его свойствам
      const isPlayer = token.kind === "player" || (token as any).isPlayer;
      minimapCtx.fillStyle = isPlayer ? "#60a5fa" : "#f59e0b";
      minimapCtx.beginPath();
      minimapCtx.arc(x + tileSize / 2, y + tileSize / 2, Math.max(2, tileSize / 4), 0, 2 * Math.PI);
      minimapCtx.fill();
    }
  }
  
  // Draw assets (only important ones)
  for (const asset of assets.values()) {
    if (asset.levelId !== levelId) continue;
    if (myRole !== "DM" && revealed && !revealed.has(`${asset.pos.x},${asset.pos.y}`)) continue;
    
    // Показываем только важные ассеты (стены, двери, окна)
    const family = inferStructuralFamily(asset.kind);
    if (!family) continue;
    const style = getStructuralStyle(asset.kind);
    
    const x = offsetX + (asset.pos.x + mapSize / 2) * tileSize;
    const y = offsetY + (asset.pos.y + mapSize / 2) * tileSize;
    
    if (x >= 0 && x < canvasWidth && y >= 0 && y < canvasHeight) {
      const fillColor = style
        ? family === "window"
          ? style.glass
          : style.fill
        : 0x6b7280;
      minimapCtx.fillStyle = hexToCss(fillColor);
      const inset = family === "wall" ? 0.18 : 0.2;
      minimapCtx.fillRect(x + tileSize * inset, y + tileSize * inset, tileSize * (1 - inset * 2), tileSize * (1 - inset * 2));
    }
  }
  
  updateMinimapViewport();
}

function updateMinimapViewport() {
  if (!minimapViewport || !minimapCanvas) return;
  
  const canvasWidth = minimapCanvas.width;
  const canvasHeight = minimapCanvas.height;
  const mapSize = 50;
  const tileSize = Math.min(canvasWidth / mapSize, canvasHeight / mapSize);
  const offsetX = (canvasWidth - mapSize * tileSize) / 2;
  const offsetY = (canvasHeight - mapSize * tileSize) / 2;
  
  // Calculate current viewport bounds in world coordinates
  const s = world.scale.x || 1;
  const worldCenterX = (-world.position.x + app.screen.width / 2) / s;
  const worldCenterY = (-world.position.y + app.screen.height / 2) / s;
  const viewW = app.screen.width / s;
  const viewH = app.screen.height / s;
  
  // Convert world coordinates to minimap coordinates
  // Минимарта показывает область от -mapSize/2 до +mapSize/2 в мировых координатах
  const minimapCenterX = offsetX + mapSize * tileSize / 2;
  const minimapCenterY = offsetY + mapSize * tileSize / 2;
  
  // Позиция центра viewport'а на минимарте
  const viewportCenterX = minimapCenterX + (worldCenterX * tileSize);
  const viewportCenterY = minimapCenterY + (worldCenterY * tileSize);
  
  // Размер viewport'а на минимарте
  const viewportW = Math.max(8, Math.min(viewW * tileSize, canvasWidth * 0.6));
  const viewportH = Math.max(8, Math.min(viewH * tileSize, canvasHeight * 0.6));
  
  // Позиция левого верхнего угла viewport'а
  const viewportX = viewportCenterX - viewportW / 2;
  const viewportY = viewportCenterY - viewportH / 2;
  
  // Ограничиваем viewport границами минимарты
  const clampedX = Math.max(offsetX, Math.min(viewportX, offsetX + mapSize * tileSize - viewportW));
  const clampedY = Math.max(offsetY, Math.min(viewportY, offsetY + mapSize * tileSize - viewportH));
  
  // Update viewport indicator
  minimapViewport.style.left = `${clampedX}px`;
  minimapViewport.style.top = `${clampedY}px`;
  minimapViewport.style.width = `${viewportW}px`;
  minimapViewport.style.height = `${viewportH}px`;
}

let socket: WebSocket | null = null;
let pendingSocket: WebSocket | null = null;
let connectionAttemptCounter = 0;
let activeAttemptId = 0;
const HEARTBEAT_INTERVAL_MS = 8000;
const HEARTBEAT_TIMEOUT_MS = 5000;
const PING_PAYLOAD = JSON.stringify({ t: "ping" as const });
let heartbeatInterval: number | null = null;
let heartbeatTimeout: number | null = null;
let heartbeatAwaitingPong = false;
let heartbeatAttemptId = 0;
let awaitingInitialPong = false;
let lastConnectedPort: number | null = null;
let reconnectTimer: number | null = null;
let preferredPort: number | null = null;

function stopHeartbeat(attemptId?: number) {
  if (typeof attemptId === "number" && attemptId !== heartbeatAttemptId) return;
  if (heartbeatInterval !== null) {
    window.clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
  if (heartbeatTimeout !== null) {
    window.clearTimeout(heartbeatTimeout);
    heartbeatTimeout = null;
  }
  heartbeatAwaitingPong = false;
  awaitingInitialPong = false;
  if (typeof attemptId !== "number" || heartbeatAttemptId === attemptId) {
    heartbeatAttemptId = 0;
  }
}

function startHeartbeat(ws: WebSocket, attemptId: number) {
  stopHeartbeat();
  heartbeatAttemptId = attemptId;
  heartbeatAwaitingPong = false;
  awaitingInitialPong = true;
  const sendPing = () => {
    if (attemptId !== activeAttemptId) return;
    if (socket !== ws || ws.readyState !== WebSocket.OPEN) {
      stopHeartbeat(attemptId);
      return;
    }
    if (heartbeatAwaitingPong) {
      try { console.warn(`[WS][client] heartbeat missed on attempt ${attemptId}, forcing reconnect`); } catch {}
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
      return;
    }
    heartbeatAwaitingPong = true;
    try {
      ws.send(PING_PAYLOAD);
    } catch (err) {
      heartbeatAwaitingPong = false;
      try { console.warn(`[WS][client] failed to send ping: ${String((err as any)?.message || err)}`); } catch {}
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
      return;
    }
    if (heartbeatTimeout !== null) window.clearTimeout(heartbeatTimeout);
    heartbeatTimeout = window.setTimeout(() => {
      if (!heartbeatAwaitingPong || attemptId !== heartbeatAttemptId) return;
      try { console.warn(`[WS][client] heartbeat timeout on attempt ${attemptId}`); } catch {}
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
    }, HEARTBEAT_TIMEOUT_MS);
  };
  sendPing();
  heartbeatInterval = window.setInterval(sendPing, HEARTBEAT_INTERVAL_MS);
}
type DragState = { tokenId: ID; sprite: Container; offset: Vec2 } | null;
let dragging: DragState = null;

function canControl(tok: Token): boolean {
  return myRole === "DM" || tok.owner === playerId;
}

function snapToGrid(x: number, y: number): Vec2 {
  return { x: Math.floor(x / CELL), y: Math.floor(y / CELL) };
}

function sendMove(tokenId: ID, pos: Vec2) {
  if (!levelId || !socket) return;
  const msg: ClientToServer = { t: "moveToken", tokenId, pos, levelId };
  socket.send(JSON.stringify(msg));
}

function sendUpdateToken(tokenId: ID, patch: Partial<Token>) {
  if (!socket) return;
  const msg: ClientToServer = { t: "updateToken", tokenId, patch };
  socket.send(JSON.stringify(msg));
}

function onDragMove(e: any) {
  if (!dragging) return;
  const p = world.toLocal(e.global);
  // Snap visual during drag to grid center
  const px = p.x + dragging.offset.x;
  const py = p.y + dragging.offset.y;
  const cell = snapToGrid(px, py);
  dragging.sprite.position.set(cell.x * CELL + CELL / 2, cell.y * CELL + CELL / 2);
}

function onDragEnd(e: any) {
  if (!dragging) return;
  const { sprite, tokenId } = dragging;
  sprite.alpha = 1;
  // Snap and send move
  const snapped = snapToGrid(sprite.x, sprite.y);
  const existingToken = tokens.get(tokenId);
  // Prevent placing on non-land (space) for players; DM is allowed anywhere
  if (myRole !== "DM" && !isGround(snapped.x, snapped.y)) {
    if (existingToken) sprite.position.set(existingToken.pos.x * CELL + CELL / 2, existingToken.pos.y * CELL + CELL / 2);
    try { hudToast("Cannot move outside floor/ground"); } catch {}
    dragging = null;
    app.stage.off("pointermove", onDragMove);
    app.stage.off("pointerup", onDragEnd);
    app.stage.off("pointerupoutside", onDragEnd);
    return;
  }
  let appliedOptimistic = false;
  if (existingToken && levelId) {
    if (existingToken.pos.x !== snapped.x || existingToken.pos.y !== snapped.y || existingToken.levelId !== levelId) {
      setPendingTokenMove(tokenId, snapped, levelId);
      appliedOptimistic = true;
    }
  }
  if (appliedOptimistic) {
    drawTokens();
  }
  sendMove(tokenId, snapped);
  // Auto-reveal around the new position using token vision
  if (socket && existingToken) {
    const movedTok = { ...(existingToken as any), pos: snapped };
    const isNPC = (existingToken as any).kind === "npc";
    if (!isNPC && (myRole === "DM" || tokenId === myTokenId)) {
      revealByVisionForToken(socket as WebSocket, movedTok);
    }
  }
  dragging = null;
  // Remove stage listeners
  app.stage.off("pointermove", onDragMove);
  app.stage.off("pointerup", onDragEnd);
  app.stage.off("pointerupoutside", onDragEnd);
}

// Context menu for object z-index management
let contextMenu: HTMLDivElement | null = null;
let contextMenuTarget: { type: "token"; id: ID } | { type: "asset"; id: ID } | null = null;

function createContextMenu() {
  if (contextMenu) return contextMenu;
  const menu = document.createElement("div");
  menu.id = "object-context-menu";
  menu.style.cssText = `
    position: fixed;
    background: #202124;
    border: 1px solid #5f6368;
    border-radius: 4px;
    padding: 4px 0;
    box-shadow: 0 2px 8px rgba(0,0,0,0.3);
    z-index: 10000;
    display: none;
    min-width: 180px;
    font-family: Inter, system-ui, sans-serif;
    font-size: 13px;
  `;
  document.body.appendChild(menu);
  contextMenu = menu;
  
  // Close on click outside
  document.addEventListener("click", () => hideContextMenu());
  
  return menu;
}

function showContextMenu(x: number, y: number, target: { type: "token"; id: ID } | { type: "asset"; id: ID }) {
  console.log(`[CLIENT] showContextMenu called with target:`, target);
  const menu = createContextMenu();
  contextMenuTarget = target;
  
  menu.innerHTML = "";
  
  const addItem = (label: string, action: () => void) => {
    const item = document.createElement("div");
    item.textContent = label;
    item.style.cssText = `
      padding: 6px 12px;
      cursor: pointer;
      color: #e8eaed;
    `;
    item.onmouseenter = () => { item.style.background = "#3c4043"; };
    item.onmouseleave = () => { item.style.background = "transparent"; };
    item.onclick = (e) => {
      e.stopPropagation();
      action();
      hideContextMenu();
    };
    menu.appendChild(item);
  };
  
  addItem("⬆️ To top", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "top" };
      console.log(`[CLIENT] Sending reorderToken:`, msg);
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "top" };
      console.log(`[CLIENT] Sending reorderAsset:`, msg);
      socket.send(JSON.stringify(msg));
    }
  });
  
  addItem("⬆ Up", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "up" };
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "up" };
      socket.send(JSON.stringify(msg));
    }
  });
  
  addItem("⬇ Down", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "down" };
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "down" };
      socket.send(JSON.stringify(msg));
    }
  });
  
  addItem("⬇️ To bottom", () => {
    if (!socket || !contextMenuTarget) return;
    if (contextMenuTarget.type === "token") {
      const msg: ClientToServer = { t: "reorderToken", tokenId: contextMenuTarget.id, direction: "bottom" };
      socket.send(JSON.stringify(msg));
    } else {
      const msg: ClientToServer = { t: "reorderAsset", assetId: contextMenuTarget.id, direction: "bottom" };
      socket.send(JSON.stringify(msg));
    }
  });
  
  // Add separator
  const separator = document.createElement("div");
  separator.style.cssText = `
    height: 1px;
    background: #5f6368;
    margin: 4px 0;
  `;
  menu.appendChild(separator);
  
  // Add dead toggle option (only for tokens, only for DM)
  if (myRole === "DM" && contextMenuTarget.type === "token") {
    const token = tokens.get(contextMenuTarget.id);
    const isDead = (token as any)?.dead;
    
    addItem(`${isDead ? "❤️" : "💀"} ${isDead ? "Resurrect" : "Kill"}`, () => {
      if (!socket || !contextMenuTarget) return;
      const msg: ClientToServer = { t: "updateToken", tokenId: contextMenuTarget.id, patch: { dead: !isDead } };
      console.log(`[CLIENT] Sending updateToken dead:`, msg);
      socket.send(JSON.stringify(msg));
    });
  }
  
  // Add hidden toggle option (only for DM)
  if (myRole === "DM") {
    const isHidden = contextMenuTarget.type === "token" 
      ? (tokens.get(contextMenuTarget.id) as any)?.hidden 
      : (assets.get(contextMenuTarget.id) as any)?.hidden;
    
    addItem(`${isHidden ? "👁️" : "🙈"} ${isHidden ? "Show" : "Hide"}`, () => {
      if (!socket || !contextMenuTarget) return;
      if (contextMenuTarget.type === "token") {
        const msg: ClientToServer = { t: "toggleTokenHidden", tokenId: contextMenuTarget.id };
        console.log(`[CLIENT] Sending toggleTokenHidden:`, msg);
        socket.send(JSON.stringify(msg));
      } else {
        const msg: ClientToServer = { t: "toggleAssetHidden", assetId: contextMenuTarget.id };
        console.log(`[CLIENT] Sending toggleAssetHidden:`, msg);
        console.log(`[CLIENT] Available assets:`, Array.from(assets.keys()).slice(0, 10));
        socket.send(JSON.stringify(msg));
      }
    });
  }
  
  // Position menu
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.display = "block";
  
  // Adjust if off-screen
  setTimeout(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${window.innerWidth - rect.width - 10}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${window.innerHeight - rect.height - 10}px`;
    }
  }, 0);
}

function hideContextMenu() {
  if (contextMenu) {
    contextMenu.style.display = "none";
  }
  contextMenuTarget = null;
}

function drawTokens() {
  console.log(`=== drawTokens() called, myRole=${myRole}, playerId=${playerId}, tokens.size=${tokens.size} ===`);
  
  // Remove existing token nodes from gameObjectsLayer and myTokensLayer
  myTokensLayer.removeChildren();
  // Remove token nodes from gameObjectsLayer
  for (let i = gameObjectsLayer.children.length - 1; i >= 0; i--) {
    const child = gameObjectsLayer.children[i];
    if ((child as any).userData?.type === "token") {
      gameObjectsLayer.removeChild(child);
    }
  }
  
  const revealed = levelId ? getRevealed(levelId) : undefined;
  
  // Sort tokens by zIndex (lower first = drawn first = behind)
  const sortedTokens = Array.from(tokens.values()).sort((a, b) => {
    const zA = (a as any).zIndex ?? 0;
    const zB = (b as any).zIndex ?? 0;
    return zA - zB;
  });
  
  console.log(`Sorted tokens count: ${sortedTokens.length}`);
  
  for (const tok of sortedTokens) {
    const pending = pendingTokenMoves.get(tok.id);
    const displayPos = pending?.pos ?? tok.pos;
    // Check if token is hidden and user is not DM
    if ((tok as any).hidden && myRole !== "DM") {
      continue; // Hide token from non-DM users
    }

    if (myRole !== "DM" && revealed && tok.id !== myTokenId && !revealed.has(`${displayPos.x},${displayPos.y}`)) {
      // hide non-owned tokens in unrevealed cells for player
      continue;
    }
    const node = new Container();
    const isNPC = (tok as any).kind === "npc";
    const isMine = tok.id === myTokenId;
    // Use custom icon if available, otherwise use default
    const emoji = (tok as any).icon || (isNPC ? "🧟" : "🧙");
    const text = new Text({
      text: emoji,
      style: {
        fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
        fontSize: Math.floor(CELL * 1.05),
        stroke: 0x202124,
        strokeThickness: 1,
      }
    } as any);
    (text as any).anchor?.set?.(0.5);
    text.position.set(0, 0);
    const labelRaw = (tok.name ?? "").trim();
    const labelText = labelRaw ? Array.from(labelRaw).slice(0, 6).join("") : "";
    const label = labelText ? new Text({
      text: labelText,
      style: {
        fontFamily: "Inter, system-ui, sans-serif",
        fontSize: Math.floor(CELL * 0.3),
        fill: 0xffffff,
        stroke: 0x202124,
        strokeThickness: 2,
        align: "center",
      }
    } as any) : null;
    if (label) {
      (label as any).anchor?.set?.(0.5, 0);
      label.position.set(0, CELL * 0.42);
    }
    // Subtle ring to improve visibility/select state
    const ring = new Graphics();
    const ringColor = isMine ? 0x8ab4f8 : 0x9aa0a6;
    ring.circle(0, 0, CELL * 0.46).stroke({ color: ringColor, width: 2, alpha: 0.8 });
    
    // Add background overlay for health status
    const backgroundOverlay = new Graphics();
    const hp = (tok as any).hp || 0;
    const isDead = (tok as any).dead;
    
    if (isDead) {
      // Black background for dead characters
      backgroundOverlay.circle(0, 0, CELL * 0.48).fill({ color: 0x000000, alpha: 0.6 });
    } else if (hp === 0) {
      // Red background for characters with 0 HP
      backgroundOverlay.circle(0, 0, CELL * 0.48).fill({ color: 0xff0000, alpha: 0.6 });
    }
    
    // Check if token is hidden for DM
    const isHidden = (tok as any).hidden && myRole === "DM";
    
    // Add skull icon for dead characters
    let skullIcon: Text | null = null;
    if (isDead) {
      skullIcon = new Text({
        text: "💀",
        style: {
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
          fontSize: Math.floor(CELL * 0.3),
          stroke: 0x202124,
          strokeThickness: 1,
        }
      } as any);
      (skullIcon as any).anchor?.set?.(1, 0);
      skullIcon.position.set(CELL * 0.35, -CELL * 0.35);
    }
    
    // Compose
    // @ts-ignore
    node.addChild(backgroundOverlay);
    // @ts-ignore
    node.addChild(ring);
    // @ts-ignore
    node.addChild(text);
    if (label) {
      // @ts-ignore
      node.addChild(label);
    }
    if (skullIcon) {
      // @ts-ignore
      node.addChild(skullIcon);
    }
    
    // Add eye icon for hidden tokens (only visible to DM)
    if (isHidden) {
      const eyeIcon = new Text({
        text: "👁️",
        style: {
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
          fontSize: Math.floor(CELL * 0.4),
          stroke: 0x202124,
          strokeThickness: 1,
        }
      } as any);
      (eyeIcon as any).anchor?.set?.(0.5);
      eyeIcon.position.set(CELL * 0.3, -CELL * 0.3);
      // @ts-ignore
      node.addChild(eyeIcon);

      // Make token semi-transparent but keep eye icon fully visible
      node.alpha = 0.5;
      eyeIcon.alpha = 1.0;
    }
    node.position.set(displayPos.x * CELL + CELL / 2, displayPos.y * CELL + CELL / 2);
    // Mark as token for cleanup
    (node as any).userData = { type: "token" };
    // Enlarge hit area to make grabbing easier
    try { (node as any).hitArea = new Circle(0, 0, CELL * 0.55); } catch {}

    // Set zIndex for proper layering (tokens use range 0-99)
    node.zIndex = (tok as any).zIndex ?? 0;
    
    // Decide which layer to use
    const shouldBeAboveFog = myRole === "PLAYER" && tok.owner === playerId;
    console.log(`Token processing: name=${tok.name}, owner=${tok.owner}, myRole=${myRole}, playerId=${playerId}, shouldBeAboveFog=${shouldBeAboveFog}, canControl=${canControl(tok)}`);
    
    // Drag & drop
    if (canControl(tok)) {
      // @ts-ignore v8 event model
      node.eventMode = "static";
      (node as any).cursor = "grab";
      node.on("pointerdown", (e: any) => {
        // If editor tool is active, do not start token drag
        if (myRole === "DM" && (editorMode === "paint" || editorMode === "eraseObjects" || editorMode === "eraseSpace" || editorMode === "eraseTokens" || editorMode === "spawnToken")) {
          document.body.style.cursor = "crosshair";
          e.stopPropagation?.();
          return;
        }
        (node as any).cursor = "grabbing";
        node.alpha = 0.9;
        const p0 = world.toLocal(e.global);
        const off = { x: node.x - p0.x, y: node.y - p0.y };
        dragging = { tokenId: tok.id, sprite: node, offset: off };
        app.stage.on("pointermove", onDragMove);
        app.stage.on("pointerup", onDragEnd);
        app.stage.on("pointerupoutside", onDragEnd);
        e.stopPropagation?.();
      });
      node.on("pointerup", () => { (node as any).cursor = "grab"; });
      node.on("pointerupoutside", () => { (node as any).cursor = "grab"; });
      node.on("pointertap", (e: any) => { 
        e.stopPropagation?.();
        if (editorMode === "eraseTokens" && myRole === "DM" && socket && socket.readyState === WebSocket.OPEN) {
          const msg: ClientToServer = { t: "removeTokenAt", levelId: tok.levelId, pos: { x: Math.floor(tok.pos.x), y: Math.floor(tok.pos.y) } };
          socket.send(JSON.stringify(msg));
        } else {
          selectedTokenId = tok.id;
          renderCharacterPanel();
        }
      });
      // Right-click context menu for z-index management
      node.on("rightclick", (e: any) => {
        e.stopPropagation?.();
        showContextMenu(e.global.x, e.global.y, { type: "token", id: tok.id });
      });

      // Add to appropriate layer
      if (shouldBeAboveFog) {
        myTokensLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} (controllable) at (${displayPos.x}, ${displayPos.y}) with zIndex=${node.zIndex} → myTokensLayer`);
      } else {
        gameObjectsLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} (controllable) at (${displayPos.x}, ${displayPos.y}) with zIndex=${node.zIndex} → gameObjectsLayer`);
      }
    } else {
      // Non-controllable tokens
      // @ts-ignore
      node.eventMode = "static";
      node.on("pointertap", (e: any) => { 
        e.stopPropagation?.();
        if (editorMode === "eraseTokens" && myRole === "DM" && socket && socket.readyState === WebSocket.OPEN) {
          const msg: ClientToServer = { t: "removeTokenAt", levelId: tok.levelId, pos: { x: Math.floor(tok.pos.x), y: Math.floor(tok.pos.y) } };
          socket.send(JSON.stringify(msg));
        } else {
          selectedTokenId = tok.id;
          renderCharacterPanel();
        }
      });
      // Right-click context menu for z-index management
      node.on("rightclick", (e: any) => {
        e.stopPropagation?.();
        showContextMenu(e.global.x, e.global.y, { type: "token", id: tok.id });
      });

      // Add to appropriate layer
      if (shouldBeAboveFog) {
        myTokensLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} at (${displayPos.x}, ${displayPos.y}) with zIndex=${node.zIndex} → myTokensLayer`);
      } else {
        gameObjectsLayer.addChild(node);
        console.log(`Token ${tok.name || 'unnamed'} at (${displayPos.x}, ${displayPos.y}) with zIndex=${node.zIndex} → gameObjectsLayer`);
      }
    }
  }
  // Force sort children by zIndex
  gameObjectsLayer.sortChildren();
  console.log(`=== drawTokens() complete. gameObjectsLayer children: ${gameObjectsLayer.children.length}, myTokensLayer children: ${myTokensLayer.children.length} ===`);
}

// Simple character panel renderer. Expects an element with id "right-panel" to exist.
function renderCharacterPanel() {
  renderRightPanel();
}

function renderRightPanel() {
  const panel = document.getElementById("right-panel");
  if (!panel) return; // panel not present in DOM yet
  if (myRole !== "DM") {
    panel.style.display = "none";
    panel.innerHTML = "";
    return;
  }
  panel.style.display = "flex";
  panel.innerHTML = renderRightPanelContent(rightPanelTab);
  hydrateRightPanel(panel);
}

function renderCharacterPanelContent(): string {
  const tok = selectedTokenId ? tokens.get(selectedTokenId) : null;
  if (!tok) {
    return '<div style="opacity:.7">No selected token</div>';
  }
  const anyTok: any = tok as any;
  const stats = anyTok.stats || {};
  const vr = Math.max(0, Math.min(20, Number(anyTok.vision?.radius ?? 0) || 0));
  const editable = canControl(tok);
  const notes = typeof anyTok.notes === "string" ? anyTok.notes : "";
  const formatNumber = (value: any) => {
    const n = Number(value);
    return Number.isFinite(n) ? String(n) : "";
  };
  const renderInput = (opts: { id: string; type: string; value: string; placeholder?: string; attrs?: string }) => {
    const placeholder = opts.placeholder ? ` placeholder="${escapeHtml(opts.placeholder)}"` : "";
    const extra = opts.attrs ? ` ${opts.attrs}` : "";
    return `<input id="${opts.id}" class="char-input" type="${opts.type}" value="${escapeHtml(opts.value)}"${placeholder}${extra} />`;
  };
  
  const renderIconSelector = (opts: { id: string; value: string; kind: "player" | "npc" }) => {
    const icons = CHARACTER_ICONS[opts.kind === "npc" ? "npcs" : "players"];
    const currentIcon = opts.value || (opts.kind === "npc" ? "🧟" : "🧙");
    const iconButtons = icons.map(icon => 
      `<button type="button" class="icon-selector-btn ${icon === currentIcon ? 'selected' : ''}" data-icon="${icon}" title="${icon}">${icon}</button>`
    ).join("");
    return `<div class="icon-selector" id="${opts.id}">${iconButtons}</div>`;
  };
  const iconMarkup = (kind: string): string => {
    if (kind.startsWith("stat-")) {
      const code = kind.slice(5).toUpperCase();
      return `<span class="char-icon char-icon--abbr">${escapeHtml(code)}</span>`;
    }
    switch (kind) {
      case "name":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4Z" fill="currentColor" opacity="0.9"/><path d="M6.2 19c.6-2.5 2.8-4.5 5.8-4.5s5.2 2 5.8 4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
      case "icon":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" fill="currentColor"/></svg></span>`;
      case "hp":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19.5 6.2 13.7a4 4 0 0 1 0-5.6 4 4 0 0 1 5.6 0l.2.3.2-.3a4 4 0 0 1 5.6 0 4 4 0 0 1 0 5.6L12 19.5Z" fill="currentColor"/></svg></span>`;
      case "ac":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21c-4.4-1.9-7.5-5.1-7.5-9.3V6.4L12 3l7.5 3.4v5.3c0 4.2-3.1 7.4-7.5 9.3Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><path d="M12 11.2v4.3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg></span>`;
      case "vision":
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/></svg></span>`;
      default:
        return `<span class="char-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/></svg></span>`;
    }
  };
  type FieldVariant = "stat";
  type FieldConfig = { icon: string; label: string; input: string; hint?: string; variant?: FieldVariant; hideLabel?: boolean };
  const renderField = (cfg: FieldConfig) => {
    const classes = ["char-field"];
    if (cfg.variant === "stat") classes.push("char-field--stat");
    const hintHtml = cfg.hint ? `<span class="char-hint">${escapeHtml(cfg.hint)}</span>` : "";
    const labelHtml = cfg.hideLabel ? "" : `<div class="char-label">${escapeHtml(cfg.label)}</div>`;
    return `<div class="${classes.join(" ")}">${iconMarkup(cfg.icon)}${labelHtml}<div class="char-control">${cfg.input}${hintHtml}</div></div>`;
  };
  const profileFields: FieldConfig[] = [
    {
      icon: "name",
      label: "Name",
      input: renderInput({ id: "char-name", type: "text", value: tok.name ?? "", placeholder: "Name" }),
    },
    {
      icon: "icon",
      label: "Icon",
      input: renderIconSelector({ id: "char-icon-selector", value: anyTok.icon || "", kind: anyTok.kind || "player" }),
    },
  ];
  const combatFields: FieldConfig[] = [
    {
      icon: "hp",
      label: "HP",
      input: renderInput({ id: "char-hp", type: "number", value: formatNumber(anyTok.hp), placeholder: "0", attrs: 'inputmode="numeric"' }),
    },
    {
      icon: "ac",
      label: "AC",
      input: renderInput({ id: "char-ac", type: "number", value: formatNumber(anyTok.ac), placeholder: "0", attrs: 'inputmode="numeric"' }),
    },
    {
      icon: "dead",
      label: "Dead",
      input: `<label class="char-checkbox-label">
        <input id="char-dead" type="checkbox" ${anyTok.dead ? 'checked' : ''} />
        <span class="char-checkbox-text">Dead</span>
      </label>`,
    },
  ];
  const statKeys: Array<{ key: keyof NonNullable<Token["stats"]>; label: string }> = [
    { key: "str", label: "STR" },
    { key: "dex", label: "DEX" },
    { key: "con", label: "CON" },
    { key: "int", label: "INT" },
    { key: "wis", label: "WIS" },
    { key: "cha", label: "CHA" },
  ];
  const statsFields = statKeys.map(({ key, label }) => renderField({
    icon: `stat-${key}`,
    label,
    input: renderInput({ id: `char-${key}`, type: "number", value: formatNumber((stats as any)[key]), placeholder: "-", attrs: `inputmode="numeric" aria-label="${label}"` }),
    variant: "stat",
    hideLabel: true,
  }));
  const visionField = renderField({
    icon: "vision",
    label: "Vision",
    input: renderInput({ id: "char-vision-radius", type: "number", value: String(vr), attrs: 'inputmode="numeric" min="0" max="20"' }),
    hint: "radius (0-20)",
  });
  return `
    <div class="char-header">Character sheet</div>
    <div class="char-section">
      <div class="char-section-title">Profile</div>
      <div class="char-fields-grid char-fields-grid--two">
        ${profileFields.map(renderField).join("")}
      </div>
    </div>
    <div class="char-section">
      <div class="char-section-title">Combat stats</div>
      <div class="char-fields-grid char-fields-grid--two">
        ${combatFields.map(renderField).join("")}
      </div>
    </div>
    <div class="char-section">
      <div class="char-section-title">Attributes</div>
      <div class="char-stats-grid">
        ${statsFields.join("")}
      </div>
    </div>
    <div class="char-section">
      <div class="char-section-title">Vision</div>
      <div class="char-fields-grid">
        ${visionField}
      </div>
    </div>
    <div class="char-section char-notes-wrapper">
      <label for="char-notes">Notes</label>
      <textarea id="char-notes" placeholder="Free text...">${escapeHtml(notes)}</textarea>
    </div>
  `;
}

function renderCharacterTabs(contentHtml: string, activeTab: RightPanelTab): string {
  return `
    <div class="char-tabs">
      <button class="char-tab ${activeTab === "character" ? "active" : ""}" data-tab="character">Character</button>
      <button class="char-tab ${activeTab === "history" ? "active" : ""}" data-tab="history">History</button>
    </div>
    <div class="char-tab-content">
      ${contentHtml}
    </div>
  `;
}

function hydrateCharacterPanel(panel: HTMLElement) {
  const tok = selectedTokenId ? tokens.get(selectedTokenId) : null;
  if (!tok) return;
  const anyTok: any = tok as any;
  const editable = canControl(tok);
  const q = <T extends Element>(sel: string) => panel.querySelector(sel) as T | null;
  const setDisabled = (el: HTMLInputElement | HTMLTextAreaElement | null) => { if (el) el.disabled = !editable; };

  [
    q<HTMLInputElement>("#char-name"),
    q<HTMLInputElement>("#char-hp"),
    q<HTMLInputElement>("#char-ac"),
    q<HTMLInputElement>("#char-str"),
    q<HTMLInputElement>("#char-dex"),
    q<HTMLInputElement>("#char-con"),
    q<HTMLInputElement>("#char-int"),
    q<HTMLInputElement>("#char-wis"),
    q<HTMLInputElement>("#char-cha"),
    q<HTMLInputElement>("#char-vision-radius"),
    q<HTMLInputElement>("#char-dead"),
    q<HTMLTextAreaElement>("#char-notes")
  ].forEach(el => setDisabled(el));

  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const parseNum = (el: HTMLInputElement, lo?: number, hi?: number) => {
    const n = Number(el.value);
    if (!Number.isFinite(n)) return undefined;
    const value = lo == null || hi == null ? n : clamp(n, lo, hi);
    el.value = String(value);
    return value;
  };

  const nameEl = q<HTMLInputElement>("#char-name");
  nameEl?.addEventListener("change", () => {
    if (!editable || !nameEl) return;
    const next = nameEl.value.trim().slice(0, 64);
    if (next !== (tok.name ?? "")) sendUpdateToken(tok.id, { name: next });
  });

  const iconSelector = q<HTMLElement>("#char-icon-selector");
  if (iconSelector) {
    iconSelector.addEventListener("click", (event) => {
      if (!editable) return;
      const target = event.target as HTMLElement;
      const icon = target?.dataset?.icon;
      if (!icon || icon === anyTok.icon) return;
      iconSelector.querySelectorAll<HTMLButtonElement>(".icon-selector-btn").forEach(btn => btn.classList.toggle("selected", btn.dataset.icon === icon));
      sendUpdateToken(tok.id, { icon });
    });
  }

  const hpEl = q<HTMLInputElement>('#char-hp');
  hpEl?.addEventListener('change', () => {
    if (!editable || !hpEl) return;
    let val = parseNum(hpEl, -999, 999);
    if (val == null) val = anyTok.hp ?? 0;
    const next = clamp(val, -999, 999);
    hpEl.value = String(next);
    if (next !== (anyTok.hp ?? 0)) sendUpdateToken(tok.id, { hp: next });
  });

  const acEl = q<HTMLInputElement>('#char-ac');
  acEl?.addEventListener('change', () => {
    if (!editable || !acEl) return;
    let val = parseNum(acEl, 0, 99);
    if (val == null) val = anyTok.ac ?? 0;
    const next = clamp(val, 0, 99);
    acEl.value = String(next);
    if (next !== (anyTok.ac ?? 0)) sendUpdateToken(tok.id, { ac: next });
  });

  const statIds: Array<[keyof NonNullable<Token["stats"]>, string, number, number]> = [
    ["str", "#char-str", -99, 99],
    ["dex", "#char-dex", -99, 99],
    ["con", "#char-con", -99, 99],
    ["int", "#char-int", -99, 99],
    ["wis", "#char-wis", -99, 99],
    ["cha", "#char-cha", -99, 99]
  ];
  for (const [key, selector, lo, hi] of statIds) {
    const el = q<HTMLInputElement>(selector);
    el?.addEventListener("change", () => {
      if (!editable || !el) return;
      let val = parseNum(el, lo, hi);
      if (val == null) val = (anyTok.stats ?? {})[key] ?? 0;
      const next = clamp(val, lo, hi);
      el.value = String(next);
      const current = (anyTok.stats ?? {})[key];
      if (current !== next) {
        sendUpdateToken(tok.id, { stats: { [key]: next } });
      }
    });
  }

  const vrEl = q<HTMLInputElement>("#char-vision-radius");
  vrEl?.addEventListener("change", () => {
    if (!editable || !vrEl) return;
    let val = parseNum(vrEl, 0, 20);
    if (val == null) val = anyTok.vision?.radius ?? 0;
    const next = clamp(val, 0, 20);
    vrEl.value = String(next);
    if (next !== (anyTok.vision?.radius ?? 0)) {
      sendUpdateToken(tok.id, { vision: { radius: next } });
      if (myRole === "DM" && socket) {
        const tmp: any = { ...anyTok, vision: { ...(anyTok.vision || {}), radius: next } };
        revealByVisionForToken(socket as WebSocket, tmp);
      }
    }
  });

  const notesEl = q<HTMLTextAreaElement>("#char-notes");
  notesEl?.addEventListener("change", () => {
    if (!editable || !notesEl) return;
    const next = notesEl.value.slice(0, 2000);
    if (next !== (anyTok.notes ?? "")) sendUpdateToken(tok.id, { notes: next });
  });

  const deadEl = q<HTMLInputElement>("#char-dead");
  deadEl?.addEventListener("change", () => {
    if (!editable || !deadEl) return;
    sendUpdateToken(tok.id, { dead: deadEl.checked });
  });
}

function renderRightPanelContent(tab: RightPanelTab): string {
  if (tab === "history") {
    const historyContent = renderHistoryPanelContent();
    return renderCharacterTabs(historyContent, tab);
  }
  const characterContent = renderCharacterPanelContent();
  return renderCharacterTabs(characterContent, tab);
}

function renderHistoryPanelContent(): string {
  if (historyEvents.length === 0) {
    return '<div style="opacity:.7">No events yet</div>';
  }
  const grouped = groupHistoryEventsByDay(historyEvents);
  const items = grouped.map(group => `
    <div class="history-day">
      <div class="history-day-label">${escapeHtml(group.label)}</div>
      <div class="history-events">
        ${group.events.map(ev => renderHistoryEvent(ev)).join("")}
      </div>
    </div>
  `).join("");
  return `
    <div class="history-scroll">
      ${items}
    </div>
  `;
}

function hydrateRightPanel(panel: HTMLElement) {
  const tabButtons = panel.querySelectorAll<HTMLButtonElement>(".char-tab");
  tabButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab === "history" ? "history" : "character";
      if (tab !== rightPanelTab) setRightPanelTab(tab);
    });
  });

  if (rightPanelTab === "character") {
    hydrateCharacterPanel(panel);
  }
}

function groupHistoryEventsByDay(events: HistoryEvent[]) {
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
  const groups: Array<{ label: string; events: HistoryEvent[] }> = [];
  for (const event of events) {
    const label = formatter.format(event.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.label === label) {
      last.events.push(event);
    } else {
      groups.push({ label, events: [event] });
    }
  }
  return groups;
}

function formatHistoryTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function renderHistoryEvent(event: HistoryEvent): string {
  const actor = event.actorName || event.actorId || "Unknown";
  const time = formatHistoryTime(event.timestamp);
  const summary = escapeHtml(event.description || event.actionType);
  const details = renderHistoryDetails(event);
  return `
    <div class="history-event">
      <div class="history-event-meta">
        <span class="history-event-time">${escapeHtml(time)}</span>
        <span class="history-event-actor">${escapeHtml(actor)}</span>
      </div>
      <div class="history-event-description">${summary}</div>
      ${details ? `<div class="history-event-details">${details}</div>` : ""}
    </div>
  `;
}

function renderHistoryDetails(event: HistoryEvent): string | null {
  const details = event.details;
  if (!details) return null;
  // Token updates already include field deltas in the main description,
  // so repeating them in the detail line adds noise unless additional metadata is present.
  const hasExtraMetadata = Boolean(details.from || details.to || (details as any).note);
  if (event.actionType === "updateToken" && !hasExtraMetadata) {
    if (!details.changes || details.changes.length > 0) {
      return null;
    }
  }
  const pieces: string[] = [];
  const target = details.targetName || details.targetKind;
  if (target) {
    pieces.push(`<strong>${escapeHtml(target)}</strong>`);
  }
  if (details.changes && details.changes.length) {
    const changeText = details.changes
      .map(change => {
        const from = change.from != null ? escapeHtml(String(change.from)) : "—";
        const to = change.to != null ? escapeHtml(String(change.to)) : "—";
        return `${escapeHtml(change.field)} ${from} → ${to}`;
      })
      .join(", ");
    if (changeText) pieces.push(changeText);
  }
  if (pieces.length <= 1) return null;
  return `<span class="history-inline">${pieces.join(" · ")}</span>`;
}

function drawAssets() {
  console.log(`=== drawAssets() called, gameObjectsLayer.children.length BEFORE cleanup: ${gameObjectsLayer.children.length} ===`);
  
  // Remove existing asset nodes from gameObjectsLayer
  for (let i = gameObjectsLayer.children.length - 1; i >= 0; i--) {
    const child = gameObjectsLayer.children[i];
    if ((child as any).userData?.type === "asset") {
      gameObjectsLayer.removeChild(child);
      // Properly destroy PixiJS objects to prevent memory leaks
      if (child.destroy) {
        child.destroy({ children: true });
      }
    }
  }
  
  console.log(`gameObjectsLayer.children.length AFTER cleanup: ${gameObjectsLayer.children.length}`);
  
  if (!levelId) return;
  const revealed = getRevealed(levelId);
  
  // Sort assets by zIndex (lower first = drawn first = behind)
  const allAssets = Array.from(assets.values());
  console.log(`[CLIENT] drawAssets: total assets=${allAssets.length}, current levelId=${levelId}`);
  console.log(`[CLIENT] drawAssets: assets by level:`, allAssets.reduce((acc, a) => {
    acc[a.levelId] = (acc[a.levelId] || 0) + 1;
    return acc;
  }, {} as Record<string, number>));
  
  const sortedAssets = allAssets
    .filter(a => a.levelId === levelId)
    .filter(a => {
      // Check if asset is hidden and user is not DM
      if ((a as any).hidden && myRole !== "DM") {
        return false; // Hide asset from non-DM users
      }
      return myRole === "DM" || revealed.has(`${a.pos.x},${a.pos.y}`);
    })
    .sort((a, b) => {
      const zA = (a as any).zIndex ?? 0;
      const zB = (b as any).zIndex ?? 0;
      return zA - zB;
    });
  
  console.log(`[CLIENT] drawAssets: filtered assets for level ${levelId}: ${sortedAssets.length}`);
  
  // Build occupancy map for structural connections (walls/windows/doors)
  const byKey = new Map<string, { kind: string; family: StructuralFamily; open?: boolean; style: StructuralStyleResolved }>();
  for (const a of sortedAssets) {
    const style = getStructuralStyle(a.kind);
    if (!style) continue;
    byKey.set(`${a.pos.x},${a.pos.y}`, { kind: a.kind, family: style.family, open: (a as any).open, style });
  }
  const isWallLike = (cell: { family: StructuralFamily; open?: boolean } | undefined) => {
    if (!cell) return false;
    if (cell.family === "door") return !cell.open; // closed door behaves like wall
    return cell.family === "wall" || cell.family === "window";
  };
  for (const a of sortedAssets) {
    console.log(`[CLIENT] Drawing asset: kind=${a.kind}, id=${a.id}, pos=(${a.pos.x}, ${a.pos.y})`);
    const node = new Container();
    // Linear, connected styles for building structures
    const structuralStyle = getStructuralStyle(a.kind);
    const structuralFamily = structuralStyle?.family ?? inferStructuralFamily(a.kind);
    if (structuralStyle) {
      const g = new Graphics();
      const thickness = CELL * structuralStyle.thickness;
      const fillColor = structuralStyle.fill;
      const strokeColor = structuralStyle.stroke;
      const glassColor = structuralStyle.glass;
      const L = byKey.get(`${a.pos.x - 1},${a.pos.y}`);
      const R = byKey.get(`${a.pos.x + 1},${a.pos.y}`);
      const U = byKey.get(`${a.pos.x},${a.pos.y - 1}`);
      const D = byKey.get(`${a.pos.x},${a.pos.y + 1}`);
      if (structuralStyle.family === "wall") {
        const hasH = isWallLike(L) || isWallLike(R);
        const hasV = isWallLike(U) || isWallLike(D);
        if (hasH) g.rect(-CELL / 2, -thickness / 2, CELL, thickness).fill(fillColor).stroke({ color: strokeColor, width: 2 });
        if (hasV) g.rect(-thickness / 2, -CELL / 2, thickness, CELL).fill(fillColor).stroke({ color: strokeColor, width: 2 });
        if (!hasH && !hasV) g.rect(-thickness / 2, -thickness / 2, thickness, thickness).fill(fillColor).stroke({ color: strokeColor, width: 2 });
      } else if (structuralStyle.family === "window") {
        const hasH = isWallLike(L) || isWallLike(R);
        const hasV = isWallLike(U) || isWallLike(D);
        const drawPanel = (w: number, h: number) =>
          g.roundRect(-w / 2, -h / 2, w, h, Math.min(12, Math.min(w, h) * 0.25))
            .fill({ color: glassColor, alpha: 0.9 })
            .stroke({ color: strokeColor, width: 2 });
        if (hasH) drawPanel(CELL, thickness);
        if (hasV) drawPanel(thickness, CELL);
        if (!hasH && !hasV) drawPanel(CELL * 0.5, CELL * 0.28);
      } else if (structuralStyle.family === "door") {
        const horiz = isWallLike(L) || isWallLike(R);
        const vert = isWallLike(U) || isWallLike(D);
        const open = (a as any).open === true;
        if (!open) {
          if (horiz && !vert) g.rect(-CELL / 2, -thickness / 2, CELL, thickness).fill(fillColor).stroke({ color: strokeColor, width: 2 });
          else if (vert && !horiz) g.rect(-thickness / 2, -CELL / 2, thickness, CELL).fill(fillColor).stroke({ color: strokeColor, width: 2 });
          else g.rect(-thickness / 2, -thickness / 2, thickness, thickness).fill(fillColor).stroke({ color: strokeColor, width: 2 });
        } else {
          const w = CELL * 0.7;
          const h = thickness;
          g.rect(-w / 2, -h / 2, w, h).fill(fillColor).stroke({ color: strokeColor, width: 2 });
          g.rotation = horiz ? Math.PI / 4 : -Math.PI / 4;
        }
      }
      node.addChild(g as any);
      node.position.set(a.pos.x * CELL + CELL / 2, a.pos.y * CELL + CELL / 2);
      (node as any).userData = { type: "asset" };
      if (typeof a.scale === "number") node.scale.set(a.scale);
      if (typeof a.rot === "number") node.rotation = a.rot;
      if (typeof a.tint === "number") (node as any).tint = a.tint;
      
      // Add eye icon for hidden assets (only visible to DM)
      const isHidden = (a as any).hidden && myRole === "DM";
      if (isHidden) {
        const eyeIcon = new Text({
          text: "👁️",
          style: {
            fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
            fontSize: Math.floor(CELL * 0.3),
            stroke: 0x202124,
            strokeThickness: 1,
          }
        } as any);
        (eyeIcon as any).anchor?.set?.(0.5);
        eyeIcon.position.set(CELL * 0.25, -CELL * 0.25);
        node.addChild(eyeIcon as any);
        
        // Make asset semi-transparent but keep eye icon fully visible
        node.alpha = 0.5;
        eyeIcon.alpha = 1.0;
      }
    } else {
      // Emoji-like for decorative items
      const emojiFor = (k: string): string => {
        switch (k) {
          // Nature and plants
          case "tree": return "🌳";
          case "rock": return "🪨";
          case "bush": return "🌿";
          case "flower": return "🌸";
          case "mushroom": return "🍄";
          case "cactus": return "🌵";
          case "vine": return "🌱";
          case "log": return "🪵";
          
          // Fire and lighting
          case "fire": return "🔥";
          case "torch": return "🕯️";
          case "candle": return "🕯️";
          case "lantern": return "🏮";
          case "campfire": return "🔥";
          
          // Weapons
          case "sword": return "🗡️";
          case "bow": return "🏹";
          case "axe": return "🪓";
          case "spear": return "🔱";
          case "mace": return "⚔️";
          case "dagger": return "🗡️";
          case "crossbow": return "🏹";
          case "shield": return "🛡️";
          
          // Armor
          case "helmet": return "⛑️";
          case "armor": return "🛡️";
          case "boots": return "👢";
          case "gloves": return "🧤";
          
          // Chests and containers
          case "chest": return "📦";
          case "barrel": return "🛢️";
          case "crate": return "📦";
          case "bag": return "🎒";
          case "basket": return "🧺";
          case "pot": return "🍯";
          
          // Kitchen utensils
          case "cauldron": return "🍲";
          case "pan": return "🍳";
          case "plate": return "🍽️";
          case "cup": return "☕";
          case "bottle": return "🍾";
          case "knife": return "🔪";
          case "fork": return "🍴";
          case "spoon": return "🥄";
          
          // Food and products
          case "bread": return "🍞";
          case "apple": return "🍎";
          case "meat": return "🥩";
          case "fish": return "🐟";
          case "cheese": return "🧀";
          case "cake": return "🍰";
          case "pie": return "🥧";
          case "soup": return "🍲";
          case "wine": return "🍷";
          case "beer": return "🍺";
          
          // Clothing
          case "hat": return "🎩";
          case "cloak": return "🧥";
          case "shirt": return "👕";
          case "pants": return "👖";
          case "dress": return "👗";
          case "shoes": return "👟";
          case "belt": return "👔";
          
          // Animals
          case "cat": return "🐱";
          case "dog": return "🐕";
          case "horse": return "🐴";
          case "bird": return "🐦";
          case "owl": return "🦉";
          case "rat": return "🐀";
          case "spider": return "🕷️";
          case "snake": return "🐍";
          case "frog": return "🐸";
          case "butterfly": return "🦋";
          case "bee": return "🐝";
          case "fish_animal": return "🐠";
          
          // Insects
          case "ant": return "🐜";
          case "fly": return "🪰";
          case "mosquito": return "🦟";
          case "beetle": return "🪲";
          case "dragonfly": return "🦟";
          
          // Gems and coins
          case "coins": return "🪙";
          case "gem": return "💎";
          case "ring": return "💍";
          case "necklace": return "📿";
          case "crown": return "👑";
          case "treasure": return "💰";
          
          // Books and magic
          case "book": return "📖";
          case "scroll": return "📜";
          case "potion": return "🧪";
          case "crystal": return "🔮";
          case "wand": return "🪄";
          case "orb": return "🔮";
          
          // Tools
          case "hammer": return "🔨";
          case "pickaxe": return "⛏️";
          case "shovel": return "🪣";
          case "rope": return "🪢";
          case "key": return "🗝️";
          case "lock": return "🔒";
          
          // Furniture
          case "chair": return "🪑";
          case "table": return "🪑";
          case "bed": return "🛏️";
          case "stool": return "🪑";
          case "bench": return "🪑";
          
          // Paths and trails
          case "path": return "🛤️";
          case "bridge": return "🌉";
          case "stairs": return "🪜";
          
          // Miscellaneous
          case "other": return "✨";
          case "mystery": return "❓";
          case "magic": return "✨";
          
          default: return "✨";
        }
      };
      const label = new Text({
        text: emojiFor(a.kind),
        style: {
          fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
          fontSize: Math.floor(CELL * 0.9),
          align: "center",
        }
      } as any);
      (label as any).anchor?.set?.(0.5);
      label.position.set(0, 0);
      node.addChild(label as any);
      node.position.set(a.pos.x * CELL + CELL / 2, a.pos.y * CELL + CELL / 2);
      (node as any).userData = { type: "asset" };
      if (typeof a.scale === "number") node.scale.set(a.scale);
      if (typeof a.rot === "number") node.rotation = a.rot;
      if (typeof a.tint === "number") (label as any).tint = a.tint;
      
      // Add eye icon for hidden assets (only visible to DM)
      const isHidden = (a as any).hidden && myRole === "DM";
      if (isHidden) {
        const eyeIcon = new Text({
          text: "👁️",
          style: {
            fontFamily: "Apple Color Emoji, Segoe UI Emoji, Noto Color Emoji, Inter, system-ui",
            fontSize: Math.floor(CELL * 0.3),
            stroke: 0x202124,
            strokeThickness: 1,
          }
        } as any);
        (eyeIcon as any).anchor?.set?.(0.5);
        eyeIcon.position.set(CELL * 0.25, -CELL * 0.25);
        node.addChild(eyeIcon as any);
        
        // Make asset semi-transparent but keep eye icon fully visible
        node.alpha = 0.5;
        eyeIcon.alpha = 1.0;
      }
    }
    // Enable dragging assets in cursor mode for DM
    if (myRole === "DM") {
      // @ts-ignore pixi v8 events
      node.eventMode = "static";
      node.cursor = editorMode === "cursor" ? "grab" : "default";
      node.on("pointerdown", (e: any) => {
        if (editorMode !== "cursor") return;
        // door toggle takes priority
        if (structuralFamily === "door" && socket) {
          const msg: ClientToServer = { t: "toggleDoor", assetId: a.id };
          socket.send(JSON.stringify(msg));
          e.stopPropagation?.();
          return;
        }
        const p0 = world.toLocal(e.global);
        const off = { x: node.x - p0.x, y: node.y - p0.y };
        draggingAsset = { assetId: a.id, kind: a.kind, sprite: node, offset: off, from: { ...a.pos } };
        node.cursor = "grabbing";
        // stage listeners
        app.stage.on("pointermove", onAssetDragMove);
        app.stage.on("pointerup", onAssetDragEnd);
        app.stage.on("pointerupoutside", onAssetDragEnd);
        e.stopPropagation?.();
      });
    }
    // Doors should be clickable for players (DM handled above to avoid double toggle)
    if (structuralFamily === "door" && myRole !== "DM") {
      // @ts-ignore
      node.eventMode = "static";
      node.cursor = editorMode === "cursor" ? "pointer" : node.cursor;
      node.on("pointerdown", (e: any) => {
        if (editorMode !== "cursor") return;
        if (!socket) return;
        const msg: ClientToServer = { t: "toggleDoor", assetId: a.id };
        socket.send(JSON.stringify(msg));
        e.stopPropagation?.();
      });
    }
    // Right-click context menu for z-index management (for all assets)
    if (myRole === "DM" || structuralFamily === "door") {
      if (!node.eventMode || node.eventMode === "auto") {
        // @ts-ignore
        node.eventMode = "static";
      }
      node.on("rightclick", (e: any) => {
        e.stopPropagation?.();
        showContextMenu(e.global.x, e.global.y, { type: "asset", id: a.id });
      });
    }
    // Add to gameObjectsLayer with zIndex (both assets and tokens use same zIndex range)
    node.zIndex = (a as any).zIndex ?? 0;
    gameObjectsLayer.addChild(node);
    console.log(`Asset ${a.kind} at (${a.pos.x}, ${a.pos.y}) with zIndex=${node.zIndex}`);
  }
  // Force sort children by zIndex
  gameObjectsLayer.sortChildren();
  console.log(`Total objects in gameObjectsLayer: ${gameObjectsLayer.children.length}`);
}

type DraggingAsset = { assetId: ID; kind: string; sprite: Container; offset: { x: number; y: number }; from: Vec2 } | null;
let draggingAsset: DraggingAsset = null;
function onAssetDragMove(e: any) {
  if (!draggingAsset) return;
  const p = world.toLocal(e.global);
  const px = p.x + draggingAsset.offset.x;
  const py = p.y + draggingAsset.offset.y;
  const cell = snapToGrid(px, py);
  draggingAsset.sprite.position.set(cell.x * CELL + CELL / 2, cell.y * CELL + CELL / 2);
}
function onAssetDragEnd(e: any) {
  if (!draggingAsset) return;
  const { sprite, from, assetId } = draggingAsset;
  const snapped = snapToGrid(sprite.x, sprite.y);
  // revert if invalid
  if (!levelId || !socket) {
    sprite.position.set(from.x * CELL + CELL / 2, from.y * CELL + CELL / 2);
  } else {
    // use moveAsset to preserve ID
    const msg: ClientToServer = { t: "moveAsset", assetId, levelId, pos: snapped };
    socket.send(JSON.stringify(msg));
  }
  draggingAsset = null;
  app.stage.off("pointermove", onAssetDragMove);
  app.stage.off("pointerup", onAssetDragEnd);
  app.stage.off("pointerupoutside", onAssetDragEnd);
}

function cellKey(v: Vec2): string { return `${v.x},${v.y}`; }

function getRevealed(level: ID): Set<string> {
  let s = revealedByLevel.get(level);
  if (!s) { s = new Set(); revealedByLevel.set(level, s); }
  return s;
}

function drawFog() {
  fogTiles.clear();
  if (!levelId) return;
  // For PLAYER we do not draw any fog tiles at all — background/floor rendering handles concealment
  if (myRole !== "DM") return;
  const revealed = getRevealed(levelId);
  const { startGX, startGY, tilesX, tilesY } = getVisibleBounds();
  for (let j = 0; j < tilesY; j++) {
    for (let i = 0; i < tilesX; i++) {
      const gx = startGX + i;
      const gy = startGY + j;
      const k = `${gx},${gy}`;
      if (isGround(gx, gy) && !revealed.has(k)) {
        // DM: semi-transparent overlay to allow editing through fog
        fogTiles.rect(gx * CELL, gy * CELL, CELL, CELL).fill({ color: 0x000000, alpha: 0.6 });
      }
    }
  }
}

function cellsInRadius(center: Vec2, r: number): Vec2[] {
  const out: Vec2[] = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) {
        out.push({ x: center.x + dx, y: center.y + dy });
      }
    }
  }
  return out;
}

function sendRevealAround(ws: WebSocket, center: Vec2, r: number) {
  if (!levelId) return;
  const cells = cellsInRadius(center, r);
  const msg: ClientToServer = { t: "revealFog", levelId, cells };
  ws.send(JSON.stringify(msg));
}

function sendRevealLOS(ws: WebSocket, center: Vec2, r: number) {
  if (!levelId) return;
  const cells = cellsLOS(center, r);
  const msg: ClientToServer = { t: "revealFog", levelId, cells };
  ws.send(JSON.stringify(msg));
}

function getTokenVisionRadius(t: any): number {
  const r = Number(t?.vision?.radius ?? 0);
  if (!Number.isFinite(r)) return 0;
  return Math.max(0, Math.min(20, r));
}

function revealByVisionForToken(ws: WebSocket, t: any) {
  if (!t || !levelId) return;
  if (t.levelId !== levelId) return; // only reveal on current level
  // Only player tokens should auto-reveal fog; NPCs must not
  if ((t as any).kind === "npc") return;
  // Only auto-reveal if fog mode is automatic
  if (fogMode !== "automatic") return;
  const r = getTokenVisionRadius(t);
  if (r > 0) sendRevealLOS(ws, t.pos, r);
}

function connect() {
  // Single-run guard (HMR-safe)
  const w = window as any;
  if (w.__DND_WS_CONNECT_SCHEDULED) { try { console.debug("[WS][client] connect() already scheduled, skipping"); } catch {} return; }
  w.__DND_WS_CONNECT_SCHEDULED = true;

  // Initialize minimap elements
  minimapCanvas = document.getElementById("minimap-canvas") as HTMLCanvasElement;
  minimapCtx = minimapCanvas?.getContext("2d") || null;
  minimapViewport = document.getElementById("minimap-viewport");
  
  console.log("[MINIMAP] Initialization:", {
    canvas: !!minimapCanvas,
    ctx: !!minimapCtx,
    viewport: !!minimapViewport
  });

  // HUD status (reuse if present)
  const hud = document.getElementById("hud");
  let statusEl = document.getElementById("status") as HTMLDivElement | null;
  if (!statusEl) { statusEl = document.createElement("div"); statusEl.id = "status"; hud?.appendChild(statusEl); }
  let mapInfoEl = document.getElementById("map-info") as HTMLDivElement | null;
  if (!mapInfoEl) { mapInfoEl = document.createElement("div"); mapInfoEl.id = "map-info"; hud?.appendChild(mapInfoEl); }
  let shareButtonEl = document.getElementById("btn-share") as HTMLButtonElement | null;
  let shareLink: string | null = null;
  const buildShareLink = (): string | null => {
    if (!SHARE_BASE_URL || !currentLocation?.id) return null;
    try {
      const url = new URL(`/map/${currentLocation.id}/`, SHARE_BASE_URL);
      return url.toString();
    } catch (err) {
      try { console.warn("[Share] Failed to build link", err); } catch {}
      return null;
    }
  };
  const refreshShareButton = () => {
    if (!shareButtonEl) return;
    shareLink = buildShareLink();
    const hasLink = Boolean(shareLink);
    shareButtonEl.disabled = !hasLink;
    shareButtonEl.setAttribute("title", hasLink ? "Copy map link" : "Link unavailable");
  };
  const setStatus = (text: string, state: "connecting" | "connected" | "disconnected" | "error") => {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.dataset.state = state;
  };
  const setMapName = (name: string | null | undefined) => {
    if (!mapInfoEl) return;
    const trimmed = (name ?? "").trim();
    const value = trimmed.length ? trimmed : "—";
    mapInfoEl.textContent = value;
    mapInfoEl.setAttribute("title", value);
    refreshShareButton();
  };

  // Map name editing functionality
  let isEditingMapName = false;
  let originalMapName = "";

  const startEditingMapName = () => {
    if (!mapInfoEl || !socket || myRole !== "DM" || isEditingMapName) return;
    
    originalMapName = currentLocation?.name || "";
    isEditingMapName = true;
    mapInfoEl.classList.add("editing");
    
    const input = document.createElement("input");
    input.type = "text";
    input.value = originalMapName;
    input.maxLength = 50;
    
    mapInfoEl.textContent = "";
    mapInfoEl.appendChild(input);
    input.focus();
    input.select();
    
    const finishEditing = (save: boolean) => {
      if (!isEditingMapName || !mapInfoEl) return;
      
      isEditingMapName = false;
      mapInfoEl.classList.remove("editing");
      
      if (save && input.value.trim() !== originalMapName) {
        const newName = input.value.trim();
        if (newName && newName !== originalMapName && socket && socket.readyState === WebSocket.OPEN) {
          const msg: ClientToServer = { t: "renameLocation", newName };
          socket.send(JSON.stringify(msg));
        }
      }
      
      mapInfoEl.removeChild(input);
      setMapName(currentLocation?.name);
    };
    
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finishEditing(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finishEditing(false);
      }
    };
    
    const handleBlur = () => {
      finishEditing(true);
    };
    
    input.addEventListener("keydown", handleKeyDown);
    input.addEventListener("blur", handleBlur);
  };

  // Add click handler to map name for editing
  mapInfoEl?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    startEditingMapName();
  });
  setStatus("WS: connecting...", "connecting");
  setMapName(null);
  refreshShareButton();
  shareButtonEl?.addEventListener("click", async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const link = buildShareLink();
    if (!link) {
      refreshShareButton();
      hudToast("Link not available yet");
      return;
    }
    shareLink = link;
    const copyViaClipboard = async () => {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        return true;
      }
      return false;
    };
    let copied = false;
    try {
      copied = await copyViaClipboard();
    } catch {
      copied = false;
    }
    if (!copied) {
      try {
        const textArea = document.createElement("textarea");
        textArea.value = link;
        textArea.style.position = "fixed";
        textArea.style.opacity = "0";
        document.body.appendChild(textArea);
        textArea.select();
        copied = document.execCommand("copy");
        textArea.remove();
      } catch {
        copied = false;
      }
    }
    if (!copied) {
      try {
        prompt("Copy map link:", link);
        copied = true;
      } catch {
        copied = false;
      }
    }
    if (copied) {
      hudToast("Link copied");
    } else {
      hudToast("Failed to copy link");
    }
  });

  const params = new URLSearchParams(location.search);
  // Parse map ID from URL path or query parameter
  let mapId: string | null = null;
  const pathMatch = location.pathname.match(/\/map\/([^\/]+)\/?/);
  if (pathMatch) {
    mapId = pathMatch[1];
  } else {
    mapId = params.get("loc");
  }
  const inv = "pl-local"; // Always use player role by default, role switching is handled via UI
  const startPort = Number(params.get("port") || 8080);
  const endPort = Number(params.get("maxPort") || (startPort + 20));
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  const host = location.hostname;

  let currentPort = startPort;
  let connecting = false;
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  const attachHandlers = (ws: WebSocket, port: number, attemptId: number) => {
    let handshakeComplete = false;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      if (attemptId !== activeAttemptId || handshakeComplete) return;
      try { console.warn(`[WS][client] handshake timeout on :${port}`); } catch {}
      setStatus("WS: handshake timeout", "error");
      if (pendingSocket === ws) pendingSocket = null;
      stopHeartbeat(attemptId);
      try { ws.close(); } catch {}
    }, 5000);
    const clearHandshakeTimer = () => {
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }
    };
    ws.addEventListener("message", (ev) => {
      if (attemptId !== activeAttemptId) return;
      const msg: ServerToClient = JSON.parse(ev.data);
      console.log(`[CLIENT] Received message:`, msg.t, msg);
      if (msg.t === "welcome") {
        handshakeComplete = true;
        clearHandshakeTimer();
        pendingSocket = null;
        socket = ws;
        preferredPort = port;
        currentPort = port;
        lastConnectedPort = port;
        setStatus(`WS: checking connection (:${port})...`, "connecting");
        startHeartbeat(ws, attemptId);
        playerId = msg.playerId;
        myRole = msg.role;
        // store location/seed
        currentLocation = msg.snapshot.location;
        fogMode = currentLocation?.fogMode ?? "automatic";
        // Update HUD map name and URL with location ID
        try {
        setMapName(currentLocation?.name);
        if (currentLocation?.id) {
          const newUrl = `${window.location.origin}/map/${currentLocation.id}/`;
          history.replaceState(null, "", newUrl);
        }
        } catch {}
        // pick first token owned by me
        tokens.clear();
        clearPendingTokenMoves();
        for (const t of msg.snapshot.tokens) {
          tokens.set(t.id, t);
          if (t.owner === playerId) { myTokenId = t.id; levelId = t.levelId; }
        }
        if (Array.isArray(msg.history)) {
          setHistoryEvents(msg.history);
        }
        // receive assets
        assets.clear();
        console.log(`[CLIENT] Receiving snapshot with ${((msg.snapshot as any).assets ?? []).length} assets`);
        for (const a of (msg.snapshot as any).assets ?? []) {
          assets.set(a.id, a);
        }
        console.log(`[CLIENT] First 5 asset IDs from snapshot:`, Array.from(assets.keys()).slice(0, 5));
        // receive floors
        const floorsArr = (msg.snapshot as any).floors as { levelId: ID; pos: Vec2; kind: FloorKind }[] | undefined;
        if (Array.isArray(floorsArr)) {
          for (const f of floorsArr) setFloorOverride(f.levelId, f.pos, f.kind);
        }
        // Ensure we have a levelId even if we don't own a token
        if (!levelId && currentLocation) {
          levelId = currentLocation.levels[0]?.id ?? null;
        }
        // choose seed for current level
        if (currentLocation && levelId) {
          const lvl = currentLocation.levels.find(l => l.id === levelId);
          currentSeed = lvl?.seed ?? null;
        }
        // apply existing fog from snapshot events, if any
        const evs = (msg as any).snapshot?.events as any[] | undefined;
        if (Array.isArray(evs)) {
          for (const e of evs) {
            if (e.type === "fogRevealed") {
              const set = getRevealed(e.levelId as ID);
              for (const c of e.cells) set.add(cellKey(c));
            }
          }
        }
        drawFloor();
        drawGrid();
        drawWalls();
        drawObjects();
        drawAssets();
        drawTokens();
        centerOnMyToken();
        // update UI state based on role
        try { (updateEditorUI as any)(); } catch {}
        // auto-reveal around DM token on join to make map visible
        if (myRole === "DM") {
          for (const t of tokens.values()) {
            revealByVisionForToken(ws, t as any);
          }
        }
        drawFog();
        renderCharacterPanel();
        // Ask server for locations list after initial sync
        try { requestLocationsList(); } catch {}
        return;
      }
      if (!handshakeComplete) {
        try { console.warn(`[WS][client] ignoring message before welcome: ${String((msg as any)?.t ?? "unknown")}`); } catch {}
        return;
      }
      if (msg.t === "pong") {
        if (heartbeatAttemptId === attemptId) {
          heartbeatAwaitingPong = false;
          if (heartbeatTimeout !== null) {
            window.clearTimeout(heartbeatTimeout);
            heartbeatTimeout = null;
          }
          if (awaitingInitialPong) {
            awaitingInitialPong = false;
            const suffix = lastConnectedPort != null ? ` (:${lastConnectedPort})` : "";
            setStatus(`WS: connected${suffix}`, "connected");
          }
        }
        return;
      }
      if ((msg as any).t === "saveData") {
        const data = (msg as any).snapshot;
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        a.href = URL.createObjectURL(blob);
        a.download = `dnd-location-${ts}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
      } else if ((msg as any).t === "reset") {
        const snap = (msg as any).snapshot as { location: Location; tokens: Token[]; assets: Asset[]; floors?: { levelId: ID; pos: Vec2; kind: FloorKind }[]; events?: any[] };
        // apply snapshot fresh
        playerId = playerId; // unchanged
        myRole = myRole; // unchanged
        currentLocation = snap.location;
        fogMode = currentLocation?.fogMode ?? "automatic";
        // Update HUD map name and URL with location ID
        try {
        setMapName(currentLocation?.name);
        if (currentLocation?.id) {
          const newUrl = `${window.location.origin}/map/${currentLocation.id}/`;
          history.replaceState(null, "", newUrl);
        }
        } catch {}
        tokens.clear();
        clearPendingTokenMoves();
        for (const t of snap.tokens) {
          tokens.set(t.id, t);
        }
        // pick my token if exists
        myTokenId = null;
        for (const t of snap.tokens) { if (t.owner === playerId) { myTokenId = t.id; break; } }
        // ensure level id/seed
        levelId = myTokenId ? tokens.get(myTokenId!)?.levelId ?? null : (currentLocation?.levels[0]?.id ?? null);
        if (currentLocation && levelId) {
          const lvl = currentLocation.levels.find(l => l.id === levelId);
          currentSeed = lvl?.seed ?? null;
        }
        // assets
        assets.clear();
        for (const a of snap.assets) assets.set(a.id, a);
        // floors
        floorsByLevel.clear();
        if (Array.isArray(snap.floors)) {
          for (const f of snap.floors) setFloorOverride(f.levelId, f.pos, f.kind);
        }
        // fog
        revealedByLevel.clear();
        if (Array.isArray(snap.events)) {
          for (const e of snap.events) {
            if ((e as any).type === "fogRevealed") {
              const set = getRevealed((e as any).levelId as ID);
              for (const c of (e as any).cells) set.add(cellKey(c));
            }
          }
        }
        drawFloor();
        drawGrid();
        drawWalls();
        drawObjects();
        drawAssets();
        drawTokens();
        centerOnMyToken();
        drawFog();
        drawMinimap();
        renderCharacterPanel();
        // ensure locations list is refreshed after switching/creating maps
        try { requestLocationsList(); } catch {}
      } else if (msg.t === "statePatch") {
        console.log(`[CLIENT] Received statePatch with ${msg.events.length} events`);
        console.log(`[CLIENT] Event types:`, msg.events.map(e => e.type));
        for (const e of msg.events) {
          if (e.type === "tokenSpawned") {
            tokens.set(e.token.id, e.token);
            if (e.token.owner === playerId) {
              myTokenId = e.token.id;
              levelId = e.token.levelId;
            }
            if (myRole === "DM") {
              revealByVisionForToken(ws, e.token as any);
            }
          } else if (e.type === "tokenRemoved") {
            tokens.delete(e.tokenId);
            resolvePendingTokenMove(e.tokenId);
            if (selectedTokenId === e.tokenId) {
              selectedTokenId = null;
              renderCharacterPanel();
            }
          } else if (e.type === "tokenMoved") {
            const tok = tokens.get(e.tokenId);
            if (tok) {
              tok.pos = e.pos;
              tok.levelId = e.levelId;
              if (myRole === "DM") {
                revealByVisionForToken(ws, tok as any);
              }
            }
            resolvePendingTokenMove(e.tokenId);
          } else if (e.type === "fogRevealed") {
            const set = getRevealed(e.levelId as ID);
            for (const c of e.cells) set.add(cellKey(c));
          } else if ((e as any).type === "fogObscured") {
            const set = getRevealed((e as any).levelId as ID);
            for (const c of (e as any).cells) set.delete(cellKey(c));
          } else if ((e as any).type === "fogModeChanged") {
            fogMode = (e as any).fogMode as FogMode;
            updateFogModeUI();
          } else if ((e as any).type === "assetPlaced") {
            const a = (e as any).asset as Asset;
            assets.set(a.id, a);
            drawAssets(); // Redraw to reflect zIndex changes
          } else if ((e as any).type === "assetUpdated") {
            const a = (e as any).asset as Asset;
            assets.set(a.id, a);
            drawAssets(); // Redraw to reflect changes
          } else if ((e as any).type === "assetRemoved") {
            const id = (e as any).assetId as ID;
            assets.delete(id);
            drawAssets();
          } else if ((e as any).type === "assetMoved") {
            const a = (e as any).asset as Asset;
            console.log(`[CLIENT] Asset moved: ${a.id} to (${a.pos.x}, ${a.pos.y})`);
            assets.set(a.id, a);
            drawAssets(); // Redraw to reflect position changes
          } else if ((e as any).type === "floorPainted") {
            const ev = e as any as { levelId: ID; pos: Vec2; kind: FloorKind | null };
            setFloorOverride(ev.levelId, ev.pos, ev.kind ?? null);
          } else if ((e as any).type === "undoPerformed") {
            console.log(`[CLIENT] Undo performed, refreshing display`);
            // The gameStateRestored event will handle the full refresh
          } else if ((e as any).type === "redoPerformed") {
            console.log(`[CLIENT] Redo performed, refreshing display`);
            // The gameStateRestored event will handle the full refresh
          } else if ((e as any).type === "tokenUpdated") {
            const anyE: any = e as any;
            if (anyE.token) {
              const full: any = anyE.token;
              tokens.set(full.id, full);
              resolvePendingTokenMove(full.id);
              drawTokens(); // Redraw to reflect zIndex changes
              drawMinimap();
              if (myRole === "DM") revealByVisionForToken(ws, full as any);
            } else {
              const ev = e as any as { type: string; tokenId: ID; patch: any };
              const t = tokens.get(ev.tokenId);
              if (t) {
                Object.assign(t, ev.patch || {});
                if (ev.patch && (Object.prototype.hasOwnProperty.call(ev.patch, "pos") || Object.prototype.hasOwnProperty.call(ev.patch, "levelId"))) {
                  resolvePendingTokenMove(ev.tokenId);
                }
                drawTokens(); // Redraw in case zIndex changed
                drawMinimap();
                if (myRole === "DM") revealByVisionForToken(ws, t as any);
              }
            }
          }
        }
        drawTokens();
        drawAssets();
        drawMinimap();
        drawFloor();
        drawGrid();
        drawWalls();
        drawFog();
      } else if (msg.t === "locationsTree") {
        try {
          const hasDemo = (() => {
            const exists = (nodes: any[]): boolean => {
              for (const n of nodes) {
                if ((n as any).type === "file") {
                  const p = String((n as any).path || "").toLowerCase();
                  if ((n as any).name === "demo-location2" || p === "demo-location2.json" || p.endsWith("/demo-location2.json")) return true;
                }
                if ((n as any).children?.length && exists((n as any).children)) return true;
              }
              return false;
            };
            return exists((msg as any).tree || []);
          })();
          console.debug(`[LOC][client] received locationsTree: nodes=${(msg as any).tree?.length ?? 0}, lastUsed=${msg.lastUsedPath ?? ""}, has demo-location2=${hasDemo}`);
        } catch {}
        lastUsedLocationPath = msg.lastUsedPath;
        if (lastUsedLocationPath) addRecent(lastUsedLocationPath);
        renderLocationsTree(msg.tree, lastUsedLocationPath);
      } else if (msg.t === "savedOk") {
        // lightweight toast and refresh locations list
        hudToast(`Saved: ${msg.path}`);
        addRecent(msg.path);
        try { requestLocationsList(); } catch {}
      } else if (msg.t === "roleChanged") {
        myRole = (msg as any).role;
        try { (updateEditorUI as any)(); } catch {}
        hudToast(`Role changed to: ${myRole === "DM" ? "Administrator" : "Player"}`);
      } else if (msg.t === "locationRenamed") {
        const newName = (msg as any).newName;
        if (currentLocation) {
          currentLocation.name = newName;
          setMapName(newName);
          hudToast(`Map renamed to: ${newName}`);
        }
      } else if (msg.t === "historySnapshot") {
        setHistoryEvents(msg.events);
      } else if (msg.t === "historyEvent") {
        appendHistoryEvent(msg.event);
      } else if ((msg as any).t === "historyRemoved") {
        const ids = Array.isArray((msg as any).eventIds) ? (msg as any).eventIds as string[] : [];
        if (ids.length > 0) {
          historyEvents = historyEvents.filter(ev => !ids.includes(ev.id));
          renderRightPanel();
        }
      } else if ((msg as any).t === "historyAdded") {
        const events = Array.isArray((msg as any).events) ? (msg as any).events as HistoryEvent[] : [];
        if (events.length > 0) {
          const seen = new Set(historyEvents.map(ev => ev.id));
          const filtered = events.filter(ev => !seen.has(ev.id));
          historyEvents = [...filtered, ...historyEvents].slice(0, HISTORY_EVENT_LIMIT);
          renderRightPanel();
        }
      } else if (msg.t === "undoRedoState") {
        console.log(`[CLIENT] Received undoRedoState:`, (msg as any).undoStack.length, (msg as any).redoStack.length);
        updateUndoRedoButtons((msg as any).undoStack, (msg as any).redoStack);
      } else if (msg.t === "gameStateRestored") {
        console.log(`[CLIENT] Received gameStateRestored, refreshing display`);
        console.log(`[CLIENT] Current assets count: ${assets.size}`);
        console.log(`[CLIENT] Current tokens count: ${tokens.size}`);
        console.log(`[CLIENT] Current floors count: ${levelId ? getFloors(levelId).size : 0}`);
        clearPendingTokenMoves();
        // Refresh all visual elements after state restoration
        drawFloor();
        drawGrid();
        drawWalls();
        drawObjects();
        drawAssets();
        drawTokens();
        drawFog();
        drawMinimap();
        renderCharacterPanel();
      } else if (msg.t === "loginResponse") {
        const loginMsg = msg as any;
        console.log("[DEBUG] Login response received:", loginMsg);
        if (loginMsg.success) {
          authState = { isAuthenticated: true, user: loginMsg.user, token: loginMsg.token };
          currentUser = loginMsg.user;
          
          // Save session to localStorage
          saveSession(loginMsg.user, loginMsg.token);
          
          // Update user dropdown
          updateUserDropdown();
          
          // Hide login screen and show main app
          hideLoginScreen();
          
          // Send join message after successful login
          if (currentUser) {
            const preferredRole = currentUser.role === 'master' ? 'DM' : 'PLAYER';
            const joinMsg: ClientToServer = { t: "join", name: currentUser.username, invite: inv, preferredRole };
            try { ws.send(JSON.stringify(joinMsg)); } catch {}
            
            // Load location by ID if specified in URL
            if (mapId) {
              const loadMsg: ClientToServer = { t: "loadLocationById", locationId: mapId };
              try { ws.send(JSON.stringify(loadMsg)); } catch {}
            }
            
          }
        } else {
          showError(loginMsg.error || 'Login failed');
          const submitBtn = document.querySelector('#login-form button[type="submit"]') as HTMLButtonElement;
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Login';
          }
        }
      } else if (msg.t === "resumeSessionResponse") {
        const resumeMsg = msg as any;
        console.log("[DEBUG] Resume session response received:", resumeMsg);
        if (resumeMsg.success && resumeMsg.user && resumeMsg.token) {
          authState = { isAuthenticated: true, user: resumeMsg.user, token: resumeMsg.token };
          currentUser = resumeMsg.user;

          // Refresh session data
          saveSession(resumeMsg.user, resumeMsg.token);

          updateUserDropdown();
          hideLoginScreen();

          if (currentUser) {
            const preferredRole = currentUser.role === 'master' ? 'DM' : 'PLAYER';
            const joinMsg: ClientToServer = { t: "join", name: currentUser.username, invite: inv, preferredRole };
            try { ws.send(JSON.stringify(joinMsg)); } catch {}

            if (mapId) {
              const loadMsg: ClientToServer = { t: "loadLocationById", locationId: mapId };
              try { ws.send(JSON.stringify(loadMsg)); } catch {}
            }
          }
        } else {
          console.warn("[DEBUG] Session resume failed:", resumeMsg.error);
          authState = { isAuthenticated: false };
          currentUser = null;
          clearSession();
          showError('Session expired. Please log in again.');
          closeUsersPanel();
          showLoginScreen();
          try { ws.send(JSON.stringify({ t: "checkFirstUser" })); } catch {}
        }
      } else if (msg.t === "logoutResponse") {
        console.log('Logout response received:', msg);
        if (logoutTimeout) {
          clearTimeout(logoutTimeout);
          logoutTimeout = null;
        }
        authState = { isAuthenticated: false };
        currentUser = null;
        clearSession();
        showLoginScreen();
        closeUsersPanel();
        try { ws.send(JSON.stringify({ t: "checkFirstUser" })); } catch {}
      } else if (msg.t === "createUserResponse") {
        const createMsg = msg as any;
        const submitBtn = document.querySelector('#create-user-form button[type="submit"]') as HTMLButtonElement;
        if (createMsg.success) {
          showPasswordModal(createMsg.user.username, createMsg.generatedPassword, "created");
          
          // Close create user modal
          const createUserModal = document.getElementById('create-user-modal');
          if (createUserModal) {
            createUserModal.style.display = 'none';
          }

          const createUserFormEl = document.getElementById('create-user-form') as HTMLFormElement | null;
          createUserFormEl?.reset();
          
          // Refresh users list
          loadUsersList();
        } else {
          showCreateUserError(createMsg.error || 'Failed to create user');
        }
        createUserPending = false;
        
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create User';
        }
      } else if (msg.t === "userListResponse") {
        const userListMsg = msg as any;
        renderUsersList(userListMsg.users);
      } else if (msg.t === "updateUserRoleResponse") {
        const updateMsg = msg as any;
        if (updateMsg.success) {
          loadUsersList(); // Refresh the list
        } else {
          alert(updateMsg.error || 'Failed to update user role');
          loadUsersList();
        }
      } else if (msg.t === "deleteUserResponse") {
        const deleteMsg = msg as any;
        if (deleteMsg.success) {
          loadUsersList(); // Refresh the list
        } else {
          alert(deleteMsg.error || 'Failed to delete user');
          loadUsersList();
        }
      } else if (msg.t === "resetUserPasswordResponse") {
        const resetMsg = msg as any;
        const usernameForToast = pendingPasswordUsername;
        closeResetPasswordModal();
        if (resetMsg.success) {
          if (usernameForToast) {
            hudToast(`Password for ${usernameForToast} updated.`);
          } else {
            hudToast('Password updated.');
          }
          loadUsersList();
        } else {
          const resetSubmit = document.getElementById('reset-password-submit') as HTMLButtonElement | null;
          if (resetSubmit) {
            resetSubmit.disabled = false;
            resetSubmit.textContent = 'Set Password';
          }
          hudToast(resetMsg.error || 'Failed to reset password');
        }
      } else if (msg.t === "changePasswordResponse") {
        const changeMsg = msg as any;
        profileChangePending = false;
        if (!profileSubmitBtn) profileSubmitBtn = document.getElementById('profile-password-submit') as HTMLButtonElement | null;
        if (profileSubmitBtn) {
          profileSubmitBtn.disabled = false;
          profileSubmitBtn.textContent = 'Update Password';
        }

        if (changeMsg.success) {
          closeProfileModal();
          authState = { isAuthenticated: false };
          currentUser = null;
          clearSession();
          showLoginScreen();
          closeUsersPanel();
          const message = changeMsg.message || 'Password updated. Please log in again.';
          showError(message);
          hudToast(message);
          try {
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ t: "checkFirstUser" }));
            }
          } catch (err) {
            console.warn("[DEBUG] Failed to send checkFirstUser after password change:", err);
          }
        } else {
          showProfileError(changeMsg.error || 'Failed to change password');
        }
      } else if (msg.t === "firstUserCheckResponse") {
        const checkMsg = msg as any;
        if (checkMsg.needsFirstUser) {
          showFirstUserScreen();
          setupFirstUserForm();
        } else {
          showLoginScreen();
          setupLoginForm();
        }
        setupUserManagement();
      } else if (msg.t === "createFirstUserResponse") {
        const createMsg = msg as any;
        const submitBtn = document.querySelector('#first-user-form button[type="submit"]') as HTMLButtonElement;
        if (createMsg.success) {
          // Show password modal
          const passwordModal = document.getElementById('password-modal');
          const createdUsername = document.getElementById('created-username');
          const generatedPassword = document.getElementById('generated-password');
          
          if (passwordModal && createdUsername && generatedPassword) {
            createdUsername.textContent = createMsg.user.username;
            (generatedPassword as HTMLInputElement).value = createMsg.generatedPassword;
            passwordModal.style.display = 'flex';
          }
          
          // Auto-login after first user creation
          setTimeout(() => {
            if (socket && socket.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({
                t: 'login',
                data: {
                  usernameOrEmail: createMsg.user.username,
                  password: createMsg.generatedPassword
                }
              }));
            }
          }, 2000);
        } else {
          showFirstUserError(createMsg.error || 'Failed to create user');
        }
        
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Create Master Account';
        }
      } else if ((msg as any).t === "error") {
        // show error toast for server-side failures
        try { hudToast(`Error: ${(msg as any).message || "unknown error"}`); } catch {}
      }
    });
    ws.addEventListener("close", (ev) => {
      if (attemptId !== activeAttemptId) return;
      clearHandshakeTimer();
      if (socket === ws) socket = null;
      if (pendingSocket === ws) pendingSocket = null;
      stopHeartbeat(attemptId);
      if (socket === null) lastConnectedPort = null;
      setStatus("WS: disconnected", "disconnected");
      try { console.warn(`[WS][client] disconnected from :${port} code=${(ev as any)?.code}`); } catch {}
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        tryConnectSequence();
      }, 1000);
    });
    ws.addEventListener("error", () => {
      if (attemptId !== activeAttemptId) return;
      clearHandshakeTimer();
      if (socket === ws) socket = null;
      if (pendingSocket === ws) pendingSocket = null;
      stopHeartbeat(attemptId);
      if (socket === null) lastConnectedPort = null;
      setStatus("WS: error", "error");
    });
  };

  async function tryConnectSequence() {
    if (reconnectTimer !== null) {
      window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (connecting) return;
    connecting = true;
    if (preferredPort != null) {
      currentPort = preferredPort;
    }
    while (true) {
      const port = currentPort;
      const wsUrl = `${protocol}://${host}:${port}/ws?inv=${encodeURIComponent(inv)}`;
      try { console.debug(`[WS][client] trying ${wsUrl}`); } catch {}
      const attemptId = ++connectionAttemptCounter;
      activeAttemptId = attemptId;
      setStatus(`WS: connecting (:${port})...`, "connecting");
      const ws = new WebSocket(wsUrl);
      pendingSocket = ws;
      const opened = await new Promise<boolean>((resolve) => {
        let done = false;
        const finish = (value: boolean) => { if (done) return; done = true; resolve(value); };
        const ok = () => {
          if (attemptId !== activeAttemptId) { finish(false); return; }
          finish(true);
        };
        const fail = () => {
          if (attemptId !== activeAttemptId) { finish(false); return; }
          finish(false);
        };
        ws.addEventListener("open", () => {
          console.log("[DEBUG] WebSocket opened");
          ok();
        }, { once: true } as any);
        ws.addEventListener("error", (err) => {
          console.log("[DEBUG] WebSocket error:", err);
          fail();
        }, { once: true } as any);
        ws.addEventListener("close", (event) => {
          console.log("[DEBUG] WebSocket closed:", event.code, event.reason);
          fail();
        }, { once: true } as any);
      });
      if (opened && attemptId === activeAttemptId) {
        try { console.log(`[WS][client] connected on :${port}`); } catch {}
        
        // Check if we have pending login data
        const pendingLogin = (window as any).pendingLogin;
        if (pendingLogin) {
          // Send login request first
          const loginMsg: ClientToServer = { 
            t: "login", 
            data: { 
              usernameOrEmail: pendingLogin.usernameOrEmail, 
              password: pendingLogin.password 
            } 
          };
          console.log("[DEBUG] Sending login message:", loginMsg);
          try { ws.send(JSON.stringify(loginMsg)); } catch {}
          // Clear pending login
          delete (window as any).pendingLogin;
        } else {
          // Check if we have a saved session
          const savedSession = loadSession();
          if (savedSession) {
            console.log("[DEBUG] Attempting session resume with stored token");
            try {
              ws.send(JSON.stringify({ t: "resumeSession", token: savedSession.token }));
            } catch (err) {
              console.error("[DEBUG] Failed to send resumeSession:", err);
            }
          } else {
            // Check if first user is needed
            try { ws.send(JSON.stringify({ t: "checkFirstUser" })); } catch {}
          }
        }
        
        attachHandlers(ws, port, attemptId);
        connecting = false;
        return;
      }
      if (attemptId !== activeAttemptId) {
        try { ws.close(); } catch {}
        continue;
      }
      try { console.warn(`[WS][client] failed to connect on :${port}`); } catch {}
      if (pendingSocket === ws) pendingSocket = null;
      setStatus("WS: offline, reconnecting...", "error");
      try { ws.close(); } catch {}
      if (preferredPort == null) {
        currentPort = port + 1 > endPort ? startPort : (port + 1);
      } else {
        currentPort = preferredPort;
      }
      await delay(500);
    }
  }

  try { console.debug(`[WS][client] connect(): scanning ports ${startPort}-${endPort}`); } catch {}
  tryConnectSequence();

  // Left panel controls
  const btnCursor = document.getElementById("btn-tool-cursor") as HTMLButtonElement | null;
  const btnEraseTokens = document.getElementById("btn-tool-erase-tokens") as HTMLButtonElement | null;
  const btnEraseObjects = document.getElementById("btn-tool-erase-objects") as HTMLButtonElement | null;
  const btnEraseSpace = document.getElementById("btn-tool-erase-space") as HTMLButtonElement | null;
  const btnAssetTree = document.getElementById("asset-tree") as HTMLButtonElement | null;
  const btnAssetRock = document.getElementById("asset-rock") as HTMLButtonElement | null;
  const btnAssetBush = document.getElementById("asset-bush") as HTMLButtonElement | null;
  const btnAssetWall = document.getElementById("asset-wall") as HTMLButtonElement | null;
  const btnAssetWindow = document.getElementById("asset-window") as HTMLButtonElement | null;
  const btnAssetDoor = document.getElementById("asset-door") as HTMLButtonElement | null;
  const btnAssetChest = document.getElementById("asset-chest") as HTMLButtonElement | null;
  const btnAssetSword = document.getElementById("asset-sword") as HTMLButtonElement | null;
  const btnAssetBow = document.getElementById("asset-bow") as HTMLButtonElement | null;
  const btnAssetCoins = document.getElementById("asset-coins") as HTMLButtonElement | null;
  const btnAssetOther = document.getElementById("asset-other") as HTMLButtonElement | null;
  const btnToolStructures = document.getElementById("btn-tool-structures") as HTMLButtonElement | null;
  const btnFloorStone = document.getElementById("floor-stone") as HTMLButtonElement | null;
  const btnFloorWood = document.getElementById("floor-wood") as HTMLButtonElement | null;
  const btnFloorWater = document.getElementById("floor-water") as HTMLButtonElement | null;
  const btnFloorSand = document.getElementById("floor-sand") as HTMLButtonElement | null;
  const btnFloorGrass = document.getElementById("floor-grass") as HTMLButtonElement | null;
  const btnFloorPath = document.getElementById("floor-path") as HTMLButtonElement | null;
  const btnFloorBridge = document.getElementById("floor-bridge") as HTMLButtonElement | null;
  const btnFloorCarpet = document.getElementById("floor-carpet") as HTMLButtonElement | null;
  const btnFloorMarble = document.getElementById("floor-marble") as HTMLButtonElement | null;
  const btnFloorDirt = document.getElementById("floor-dirt") as HTMLButtonElement | null;
  const btnFloorMud = document.getElementById("floor-mud") as HTMLButtonElement | null;
  const btnFloorSnow = document.getElementById("floor-snow") as HTMLButtonElement | null;
  const btnFloorIce = document.getElementById("floor-ice") as HTMLButtonElement | null;
  const btnNewMap = document.getElementById("btn-new-map") as HTMLButtonElement | null;
  const btnNewFolder = document.getElementById("btn-new-folder") as HTMLButtonElement | null;
  const btnAddPlayer = document.getElementById("btn-add-player") as HTMLButtonElement | null;
  const btnAddNPC = document.getElementById("btn-add-npc") as HTMLButtonElement | null;
  const btnUndo = document.getElementById("btn-undo") as HTMLButtonElement | null;
  const btnRedo = document.getElementById("btn-redo") as HTMLButtonElement | null;
  const locationsTreeEl = document.getElementById("locations-tree") as HTMLDivElement | null;
  const btnToolBrush = document.getElementById("btn-tool-brush") as HTMLButtonElement | null;
  const brushSizeIndicator = document.getElementById("brush-size-indicator") as HTMLSpanElement | null;
  const btnBrush1 = document.getElementById("brush-1") as HTMLButtonElement | null;
  const btnBrush2 = document.getElementById("brush-2") as HTMLButtonElement | null;
  const btnBrush3 = document.getElementById("brush-3") as HTMLButtonElement | null;
  const btnBrush4 = document.getElementById("brush-4") as HTMLButtonElement | null;
  const btnRevealFog = document.getElementById("btn-tool-reveal-fog") as HTMLButtonElement | null;
  const btnEraseFog = document.getElementById("btn-tool-erase-fog") as HTMLButtonElement | null;
  const locationsDrawerEl = document.getElementById("locations-drawer") as HTMLDivElement | null;
  const locationsToggleBtn = document.getElementById("locations-toggle") as HTMLButtonElement | null;
  const locationsCloseBtn = document.getElementById("locations-close") as HTMLButtonElement | null;
  const dockButtons = Array.from(document.querySelectorAll<HTMLButtonElement>("#tool-dock .dock-btn"));
  const structureSelectButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".structure-select"));

  let activeToolPanel: HTMLElement | null = null;
  let activeDockButton: HTMLButtonElement | null = null;

  function closeToolPanels() {
    // Remove 'open' class from all panels
    const allToolPanels = document.querySelectorAll('#tool-panels .tool-popover');
    allToolPanels.forEach(panel => {
      panel.classList.remove("open");
    });

    // Remove 'open' class from all dock buttons
    const allDockButtons = document.querySelectorAll('#tool-dock .dock-btn');
    allDockButtons.forEach(btn => {
      btn.classList.remove("open");
    });

    // Reset state variables
    activeToolPanel = null;
    activeDockButton = null;
  }

  function positionPanelForButton(btn: HTMLButtonElement, panel: HTMLElement) {
    // Don't position panels for hidden buttons
    if (btn.style.display === 'none') {
      return;
    }
    
    const rect = btn.getBoundingClientRect();
    const panelWidth = panel.offsetWidth || 260; // Default width if not calculated yet
    const panelHeight = panel.offsetHeight || 200; // Default height if not calculated yet
    
    // Calculate position relative to viewport
    let left = rect.right + 14;
    // Position panel to align with the center of the button (CSS transform handles the centering)
    let top = rect.top + rect.height / 2;
    
    // Ensure panel doesn't go off-screen
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Adjust horizontal position if panel would go off-screen
    if (left + panelWidth > viewportWidth - 20) {
      left = rect.left - panelWidth - 14; // Position to the left of button
    }
    
    // Adjust vertical position if panel would go off-screen
    if (top < 20) {
      top = 20;
    } else if (top + panelHeight > viewportHeight - 20) {
      top = viewportHeight - panelHeight - 20;
    }
    
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
  }

  function toggleToolPanel(btn: HTMLButtonElement, panel: HTMLElement) {
    // Don't open panels for hidden buttons or hidden panels
    if (btn.style.display === 'none' || panel.style.display === 'none') {
      return;
    }
    
    // Check if this panel is already open
    if (panel.classList.contains("open")) {
      closeToolPanels();
      return;
    }
    
    // Close all other panels first
    closeToolPanels();
    
    // Open this panel
    positionPanelForButton(btn, panel);
    panel.classList.add("open");
    btn.classList.add("open");
    activeToolPanel = panel;
    activeDockButton = btn;
  }

  dockButtons.forEach((btn) => {
    const panelId = btn.dataset.panel;
    if (!panelId) return;
    const panel = document.getElementById(panelId) as HTMLElement | null;
    if (!panel) return;
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      toggleToolPanel(btn, panel);
    });
  });

  document.addEventListener("click", (ev) => {
    const target = ev.target as Node | null;
    if (activeToolPanel && target && !activeToolPanel.contains(target) && !activeDockButton?.contains(target as Node)) {
      closeToolPanels();
    }
  });
  window.addEventListener("resize", () => closeToolPanels());

  let locationsDrawerOpen = false;
  const setLocationsOpen = (open: boolean) => {
    locationsDrawerOpen = open;
    if (locationsDrawerEl) {
      locationsDrawerEl.classList.toggle("open", open);
      locationsDrawerEl.setAttribute("aria-hidden", open ? "false" : "true");
    }
    if (locationsToggleBtn) {
      locationsToggleBtn.setAttribute("aria-expanded", open ? "true" : "false");
    }
    document.body.classList.toggle("locations-open", open);
    if (open) closeToolPanels();
  };
  const toggleLocations = () => setLocationsOpen(!locationsDrawerOpen);
  const closeLocations = () => setLocationsOpen(false);

  locationsToggleBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    toggleLocations();
  });
  locationsCloseBtn?.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeLocations();
  });

  document.addEventListener("click", (ev) => {
    if (!locationsDrawerOpen) return;
    const target = ev.target as Node | null;
    if (locationsDrawerEl?.contains(target) || locationsToggleBtn?.contains(target as Node)) return;
    closeLocations();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      if (locationsDrawerOpen) closeLocations();
      if (activeToolPanel) closeToolPanels();
    }
  });

  setLocationsOpen(false);


  btnUndo?.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeToolPanels();
    console.log(`[CLIENT] Undo button clicked, role: ${myRole}, socket: ${!!socket}`);
    if (socket && myRole === "DM") {
      const msg: ClientToServer = { t: "undo" };
      console.log(`[CLIENT] Sending undo message:`, msg);
      socket.send(JSON.stringify(msg));
    } else {
      hudToast("Only DM can undo actions");
    }
  });
  btnRedo?.addEventListener("click", (ev) => {
    ev.preventDefault();
    closeToolPanels();
    console.log(`[CLIENT] Redo button clicked, role: ${myRole}, socket: ${!!socket}`);
    if (socket && myRole === "DM") {
      const msg: ClientToServer = { t: "redo" };
      console.log(`[CLIENT] Sending redo message:`, msg);
      socket.send(JSON.stringify(msg));
    } else {
      hudToast("Only DM can redo actions");
    }
  });

  function updateDockSelection() {
    const determineGroup = (): string => {
      if (editorMode === "revealFog" || editorMode === "eraseFog") return "fog";
      if (editorMode === "spawnToken" || editorMode === "eraseTokens" || selectedTokenKind) return "characters";
      if (selectedFloorKind || editorMode === "eraseSpace") return "floors";
      if (selectedAssetKind) {
        const structural = inferStructuralFamily(selectedAssetKind);
        if (structural) return "structures";
        return "assets";
      }
      if (editorMode === "eraseObjects") return "assets";
      return "cursor";
    };
    const activeGroup = determineGroup();
    dockButtons.forEach((btn) => {
      const group = btn.dataset.group;
      btn.classList.toggle("is-selected", group === activeGroup);
    });
  }

  function updateFogModeUI() {
    const fogModeToggle = document.getElementById("fog-mode-toggle") as HTMLInputElement | null;
    if (fogModeToggle) {
      fogModeToggle.checked = fogMode === "manual";
    }
  }

  function updateEditorUI() {
    const isDM = myRole === "DM";
    const bottomAssetMenu = document.getElementById("bottom-asset-menu") as HTMLElement | null;
    if (bottomAssetMenu) {
      bottomAssetMenu.style.display = isDM ? "flex" : "none";
    }
    if (document.body) {
      document.body.style.paddingBottom = isDM ? "" : "0px";
      document.body.classList.toggle("mode-dm", isDM);
      if (!isDM) {
        document.body.classList.remove("assets-collapsed");
      }
    }

    if (brushSizeIndicator) {
      const nextValue = String(brushSize);
      if (brushSizeIndicator.textContent !== nextValue) {
        brushSizeIndicator.textContent = nextValue;
      }
      brushSizeIndicator.classList.toggle("hidden", !isDM);
    }
    if (btnToolBrush) {
      const sizeLabel = `${brushSize}\u00D7${brushSize}`;
      const nextAria = `Brush settings, size ${sizeLabel}`;
      if (btnToolBrush.getAttribute("aria-label") !== nextAria) {
        btnToolBrush.setAttribute("aria-label", nextAria);
      }
      const nextLabel = `Brush (${sizeLabel})`;
      if (btnToolBrush.getAttribute("data-label") !== nextLabel) {
        btnToolBrush.setAttribute("data-label", nextLabel);
      }
    }
    
    // Force close any open panels first and remove all open classes
    closeToolPanels();
    
    // Additional cleanup: remove open classes from all panels regardless of visibility
    const allToolPanels = document.querySelectorAll('#tool-panels .tool-popover');
    allToolPanels.forEach(panel => {
      panel.classList.remove("open");
      // Force hide panels that should be hidden
      if (!isDM && (panel.id === 'panel-characters' || panel.id === 'panel-brush' || panel.id === 'panel-fog' || panel.id === 'panel-assets' || panel.id === 'panel-floors')) {
        (panel as HTMLElement).style.display = 'none';
        panel.classList.remove("open");
      }
    });
    
    const allDockButtons = document.querySelectorAll('#tool-dock .dock-btn');
    allDockButtons.forEach(btn => {
      btn.classList.remove("open");
    });
    
    // Hide/show tool panels based on role
    const toolPanels = document.querySelectorAll('#tool-panels .tool-popover');
    toolPanels.forEach(panel => {
      const panelId = panel.id;
      if (panelId === 'panel-characters') {
        // Characters panel is only for DM
        (panel as HTMLElement).style.display = isDM ? 'block' : 'none';
      } else if (panelId === 'panel-brush' || panelId === 'panel-fog' || panelId === 'panel-assets' || panelId === 'panel-floors') {
        // These panels are only for DM
        (panel as HTMLElement).style.display = isDM ? 'block' : 'none';
      }
    });
    
    // Hide/show dock buttons based on role
    const dockButtons = document.querySelectorAll('#tool-dock .dock-btn');
    dockButtons.forEach(btn => {
      const group = btn.getAttribute('data-group');
      if (group === 'characters') {
        // Characters button is only for DM
        (btn as HTMLElement).style.display = isDM ? 'flex' : 'none';
      } else if (group === 'brush' || group === 'fog' || group === 'assets' || group === 'floors' || group === 'structures') {
        // These buttons are only for DM
        (btn as HTMLElement).style.display = isDM ? 'flex' : 'none';
      }
    });
    
    // Disable/enable buttons
    if (btnCursor) btnCursor.disabled = false; // cursor is always available
    if (btnEraseTokens) btnEraseTokens.disabled = !isDM;
    if (btnEraseObjects) btnEraseObjects.disabled = !isDM;
    if (btnEraseSpace) btnEraseSpace.disabled = !isDM;
    if (btnAssetTree) btnAssetTree.disabled = !isDM;
    if (btnAssetRock) btnAssetRock.disabled = !isDM;
    if (btnAssetBush) btnAssetBush.disabled = !isDM;
    if (btnAssetWall) btnAssetWall.disabled = !isDM;
    if (btnAssetWindow) btnAssetWindow.disabled = !isDM;
    if (btnAssetDoor) btnAssetDoor.disabled = !isDM;
    if (btnAssetChest) btnAssetChest.disabled = !isDM;
    if (btnAssetSword) btnAssetSword.disabled = !isDM;
    if (btnAssetBow) btnAssetBow.disabled = !isDM;
    if (btnAssetCoins) btnAssetCoins.disabled = !isDM;
    if (btnAssetOther) btnAssetOther.disabled = !isDM;
    structureSelectButtons.forEach((btn) => { btn.disabled = !isDM; });
    if (btnFloorStone) btnFloorStone.disabled = !isDM;
    if (btnFloorWood) btnFloorWood.disabled = !isDM;
    if (btnFloorWater) btnFloorWater.disabled = !isDM;
    if (btnFloorSand) btnFloorSand.disabled = !isDM;
    if (btnFloorGrass) btnFloorGrass.disabled = !isDM;
    if (btnBrush1) btnBrush1.disabled = !isDM;
    if (btnBrush2) btnBrush2.disabled = !isDM;
    if (btnBrush3) btnBrush3.disabled = !isDM;
    if (btnBrush4) btnBrush4.disabled = !isDM;
    if (btnNewMap) btnNewMap.disabled = !isDM;
    if (btnNewFolder) btnNewFolder.disabled = !isDM;
    if (btnRevealFog) btnRevealFog.disabled = !isDM;
    if (btnEraseFog) btnEraseFog.disabled = !isDM;
    if (btnAddPlayer) btnAddPlayer.disabled = !isDM;
    if (btnAddNPC) btnAddNPC.disabled = !isDM;
    if (btnUndo) btnUndo.disabled = !isDM;
    if (btnRedo) btnRedo.disabled = !isDM;
    
    // Reset editor mode if switching to player role
    if (!isDM && (editorMode === "paint" || editorMode === "eraseObjects" || editorMode === "eraseSpace" || editorMode === "eraseTokens" || editorMode === "spawnToken" || editorMode === "revealFog" || editorMode === "eraseFog")) {
      editorMode = "cursor";
      selectedAssetKind = null;
      selectedFloorKind = null;
      selectedTokenKind = null;
    }
    
    // selected states
    btnEraseTokens?.classList.toggle("selected", editorMode === "eraseTokens");
    btnEraseObjects?.classList.toggle("selected", editorMode === "eraseObjects");
    btnEraseSpace?.classList.toggle("selected", editorMode === "eraseSpace");
    btnAssetTree?.classList.toggle("selected", selectedAssetKind === "tree");
    btnAssetRock?.classList.toggle("selected", selectedAssetKind === "rock");
    btnAssetBush?.classList.toggle("selected", selectedAssetKind === "bush");
    btnAssetWall?.classList.toggle("selected", selectedAssetKind === "wall");
    btnAssetWindow?.classList.toggle("selected", selectedAssetKind === "window");
    btnAssetDoor?.classList.toggle("selected", selectedAssetKind === "door");
    btnAssetChest?.classList.toggle("selected", selectedAssetKind === "chest");
    btnAssetSword?.classList.toggle("selected", selectedAssetKind === "sword");
    btnAssetBow?.classList.toggle("selected", selectedAssetKind === "bow");
    btnAssetCoins?.classList.toggle("selected", selectedAssetKind === "coins");
    btnAssetOther?.classList.toggle("selected", selectedAssetKind === "other");
    document.querySelectorAll<HTMLElement>('.asset-item').forEach(item => {
      const id = item.getAttribute('data-asset-id');
      item.classList.toggle('selected', !!id && id === selectedAssetKind);
    });
    structureSelectButtons.forEach(btn => {
      const assetId = btn.dataset.assetId;
      btn.classList.toggle('selected', assetId === selectedAssetKind);
    });
    btnFloorStone?.classList.toggle("selected", selectedFloorKind === "stone");
    btnFloorWood?.classList.toggle("selected", selectedFloorKind === "wood");
    btnFloorWater?.classList.toggle("selected", selectedFloorKind === "water");
    btnFloorSand?.classList.toggle("selected", selectedFloorKind === "sand");
    btnFloorGrass?.classList.toggle("selected", selectedFloorKind === "grass");
    btnBrush1?.classList.toggle("selected", brushSize === 1);
    btnBrush2?.classList.toggle("selected", brushSize === 2);
    btnBrush3?.classList.toggle("selected", brushSize === 3);
    btnBrush4?.classList.toggle("selected", brushSize === 4);
    btnRevealFog?.classList.toggle("selected", editorMode === "revealFog");
    btnEraseFog?.classList.toggle("selected", editorMode === "eraseFog");
    // Token spawn selection state
    btnAddPlayer?.classList.toggle("selected", editorMode === "spawnToken" && selectedTokenKind === "player");
    btnAddNPC?.classList.toggle("selected", editorMode === "spawnToken" && selectedTokenKind === "npc");
    
    updateDockSelection();
    
    // Redraw everything to reflect role changes
    drawFloor();
    drawGrid();
    drawWalls();
    drawObjects();
    drawAssets();
    drawTokens();
    drawFog();
    drawMinimap();
  }

  function updateUndoRedoButtons(undoStack: any[], redoStack: any[]) {
    const isDM = myRole === "DM";
    
    // Update undo button
    if (btnUndo) {
      btnUndo.disabled = !isDM || undoStack.length === 0;
      btnUndo.title = undoStack.length > 0 
        ? `Undo: ${undoStack[undoStack.length - 1]?.description || "previous action"}` 
        : "Undo previous action";
    }
    
    // Update redo button
    if (btnRedo) {
      btnRedo.disabled = !isDM || redoStack.length === 0;
      btnRedo.title = redoStack.length > 0 
        ? `Redo: ${redoStack[redoStack.length - 1]?.description || "undone action"}` 
        : "Redo action";
    }
  }

  updateEditorUI();
  updateFogModeUI();
  // Editor tool buttons
  btnCursor?.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    closeToolPanels();
    editorMode = "cursor";
    selectedAssetKind = null;
    selectedFloorKind = null;
    selectedTokenKind = null;
    updateEditorUI();
  });
  btnEraseTokens?.addEventListener("click", () => { 
    editorMode = "eraseTokens"; 
    selectedAssetKind = null; 
    selectedFloorKind = null; 
    selectedTokenKind = null;
    document.body.style.cursor = "crosshair";
    updateEditorUI(); 
  });
  btnEraseObjects?.addEventListener("click", () => { editorMode = "eraseObjects"; selectedAssetKind = null; selectedFloorKind = null; selectedTokenKind = null; updateEditorUI(); });
  btnEraseSpace?.addEventListener("click", () => { editorMode = "eraseSpace"; selectedAssetKind = null; selectedFloorKind = null; selectedTokenKind = null; updateEditorUI(); });
  btnAssetTree?.addEventListener("click", () => { selectedAssetKind = "tree"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetRock?.addEventListener("click", () => { selectedAssetKind = "rock"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetBush?.addEventListener("click", () => { selectedAssetKind = "bush"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetWall?.addEventListener("click", () => { selectedAssetKind = "wall"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetWindow?.addEventListener("click", () => { selectedAssetKind = "window"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetDoor?.addEventListener("click", () => { selectedAssetKind = "door"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetChest?.addEventListener("click", () => { selectedAssetKind = "chest"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetSword?.addEventListener("click", () => { selectedAssetKind = "sword"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetBow?.addEventListener("click", () => { selectedAssetKind = "bow"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetCoins?.addEventListener("click", () => { selectedAssetKind = "coins"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnAssetOther?.addEventListener("click", () => { selectedAssetKind = "other"; selectedFloorKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  structureSelectButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      if (myRole !== "DM") return;
      const assetId = btn.dataset.assetId;
      if (!assetId) return;
      selectedAssetKind = assetId;
      selectedFloorKind = null;
      selectedTokenKind = null;
      editorMode = "paint";
      updateEditorUI();
    });
  });
  btnFloorStone?.addEventListener("click", () => { selectedFloorKind = "stone"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorWood?.addEventListener("click", () => { selectedFloorKind = "wood"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorWater?.addEventListener("click", () => { selectedFloorKind = "water"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorSand?.addEventListener("click", () => { selectedFloorKind = "sand"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorGrass?.addEventListener("click", () => { selectedFloorKind = "grass"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorPath?.addEventListener("click", () => { selectedFloorKind = "path"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorBridge?.addEventListener("click", () => { selectedFloorKind = "bridge"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorCarpet?.addEventListener("click", () => { selectedFloorKind = "carpet"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorMarble?.addEventListener("click", () => { selectedFloorKind = "marble"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorDirt?.addEventListener("click", () => { selectedFloorKind = "dirt"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorMud?.addEventListener("click", () => { selectedFloorKind = "mud"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorSnow?.addEventListener("click", () => { selectedFloorKind = "snow"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnFloorIce?.addEventListener("click", () => { selectedFloorKind = "ice"; selectedAssetKind = null; selectedTokenKind = null; editorMode = "paint"; updateEditorUI(); });
  btnBrush1?.addEventListener("click", () => { brushSize = 1; updateEditorUI(); });
  btnBrush2?.addEventListener("click", () => { brushSize = 2; updateEditorUI(); });
  btnBrush3?.addEventListener("click", () => { brushSize = 3; updateEditorUI(); });
  btnBrush4?.addEventListener("click", () => { brushSize = 4; updateEditorUI(); });
  btnRevealFog?.addEventListener("click", () => { editorMode = "revealFog"; selectedAssetKind = null; selectedFloorKind = null; updateEditorUI(); });
  btnEraseFog?.addEventListener("click", () => { editorMode = "eraseFog"; selectedAssetKind = null; selectedFloorKind = null; updateEditorUI(); });
  btnRevealFog?.addEventListener("click", () => { selectedTokenKind = null; });
  btnEraseFog?.addEventListener("click", () => { selectedTokenKind = null; });
  
  // Fog mode toggle handler
  const fogModeToggle = document.getElementById("fog-mode-toggle") as HTMLInputElement | null;
  fogModeToggle?.addEventListener("change", () => {
    if (!socket || myRole !== "DM") return;
    const newMode: FogMode = fogModeToggle.checked ? "manual" : "automatic";
    const msg: ClientToServer = { t: "setFogMode", fogMode: newMode };
    socket.send(JSON.stringify(msg));
  });
  
  btnAddPlayer?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    selectedTokenKind = "player";
    selectedAssetKind = null; selectedFloorKind = null;
    editorMode = "spawnToken";
    document.body.style.cursor = "crosshair";
    updateEditorUI();
  });
  btnAddNPC?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    selectedTokenKind = "npc";
    selectedAssetKind = null; selectedFloorKind = null;
    editorMode = "spawnToken";
    document.body.style.cursor = "crosshair";
    updateEditorUI();
  });
  btnNewMap?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    const name = prompt("New map name:", "New map");
    if (name == null) return;
    const levelIdNew: ID = uid("lvl");
    const locationIdNew: ID = uid("loc");
    const seed = `seed-${Date.now().toString(36)}`;
    const snap: GameSnapshot = {
      location: { id: locationIdNew, name: name || "New map", levels: [{ id: levelIdNew, seed, spawnPoint: { x: 5, y: 5 }, lights: [] }] },
      tokens: [],
      assets: [],
      floors: [],
      events: [] as Event[],
    };
    const msg: ClientToServer = { t: "loadSnapshot", snapshot: snap };
    socket.send(JSON.stringify(msg));
    // Immediately persist to disk so it appears in the list
    const slug = (name || "map")
      .replace(/[\\/]/g, "-")
      .replace(/\s+/g, "-")
      .replace(/^-+|-+$/g, "") || "map";
    const relPath = `${slug}.json`;
    const saveMsg: ClientToServer = { t: "saveLocation", path: relPath };
    socket.send(JSON.stringify(saveMsg));
  });

  btnNewFolder?.addEventListener("click", () => {
    if (!socket || myRole !== "DM") return;
    const rel = prompt("Enter folder path (relative to root):", "new-folder");
    if (rel == null) return;
    const pathClean = rel.replace(/\\+/g, "/").replace(/^\/+|\/+$/g, "");
    if (!pathClean) return;
    const msg: ClientToServer = { t: "createFolder", path: pathClean };
    socket.send(JSON.stringify(msg));
  });


  // Drag and drop state
  let draggedElement: HTMLElement | null = null;
  let draggedNode: LocationTreeNode | null = null;

  function setupDragAndDropHandlers(element: HTMLElement, node: LocationTreeNode) {
    // Only allow drag for DM role
    if (myRole !== "DM") return;

    // Make files draggable
    if (node.type === "file") {
      element.draggable = true;
      
      element.addEventListener("dragstart", (e) => {
        draggedElement = element;
        draggedNode = node;
        element.classList.add("dragging");
        e.dataTransfer!.effectAllowed = "move";
        e.dataTransfer!.setData("text/plain", node.path);
      });

      element.addEventListener("dragend", () => {
        element.classList.remove("dragging");
        // Clear all drag-over classes
        document.querySelectorAll(".loc-item").forEach(el => {
          el.classList.remove("drag-over", "drag-over-folder");
        });
        draggedElement = null;
        draggedNode = null;
      });
    }

    // Make folders drop targets
    if (node.type === "folder") {
      element.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        element.classList.add("drag-over-folder");
      });

      element.addEventListener("dragleave", (e) => {
        // Only remove class if we're actually leaving the element
        if (!element.contains(e.relatedTarget as Node)) {
          element.classList.remove("drag-over-folder");
        }
      });

      element.addEventListener("drop", (e) => {
        e.preventDefault();
        element.classList.remove("drag-over-folder");
        
        if (!draggedNode || !socket) return;
        
        // Don't allow dropping a folder into itself or its children
        if (draggedNode.type === "folder" && node.path.startsWith(draggedNode.path + "/")) {
          hudToast("Cannot move folder into itself or its subfolders");
          return;
        }
        
        // Don't allow dropping a file into its current folder
        if (draggedNode.type === "file") {
          const currentFolder = draggedNode.path.substring(0, draggedNode.path.lastIndexOf("/"));
          if (currentFolder === node.path) {
            return; // Already in this folder
          }
        }
        
        // Move the item to the target folder
        const msg: ClientToServer = { 
          t: "moveLocation", 
          from: draggedNode.path, 
          toFolder: node.path 
        };
        socket.send(JSON.stringify(msg));
      });
    }

    // Make files drop targets too (for moving to root)
    if (node.type === "file") {
      element.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = "move";
        element.classList.add("drag-over");
      });

      element.addEventListener("dragleave", (e) => {
        if (!element.contains(e.relatedTarget as Node)) {
          element.classList.remove("drag-over");
        }
      });

      element.addEventListener("drop", (e) => {
        e.preventDefault();
        element.classList.remove("drag-over");
        
        if (!draggedNode || !socket) return;
        
        // Move to root (same level as this file)
        const parentPath = node.path.substring(0, node.path.lastIndexOf("/"));
        const msg: ClientToServer = { 
          t: "moveLocation", 
          from: draggedNode.path, 
          toFolder: parentPath || "" 
        };
        socket.send(JSON.stringify(msg));
      });
    }
  }

  function renderLocationsTree(tree: LocationTreeNode[], lastUsed?: string) {
    if (!locationsTreeEl) return;
    locationsTreeEl.innerHTML = "";
    // Build path map for quick lookup (used by Recent)
    try { console.debug(`[LOC][client] renderLocationsTree: treeRoots=${tree.length}, lastUsed=${lastUsed ?? ""}`); } catch {}
    const pathMap = new Map<string, LocationTreeNode>();
    const walk = (n: LocationTreeNode) => { pathMap.set(n.path, n); if (n.children) n.children.forEach(walk); };
    for (const n of tree) walk(n);
    try {
      const hasDemo = Array.from(pathMap.keys()).some((k) => {
        const p = k.toLowerCase();
        return p === "demo-location2.json" || p.endsWith("/demo-location2.json");
      });
      console.debug(`[LOC][client] pathMap size=${pathMap.size}, has demo-location2=${hasDemo}`);
    } catch {}

    // Clean up recent list: remove items not present in tree
    const prevCount = recentLocations.length;
    const cleaned = recentLocations.filter((p) => {
      const lower = p.toLowerCase();
      // Keep demo and test entries now; only require presence in the tree
      return pathMap.has(p);
    });
    try { console.debug(`[LOC][client] recent before=${prevCount}, afterFilter=${cleaned.length}`); } catch {}
    if (cleaned.length !== recentLocations.length) {
      recentLocations = cleaned;
      saveRecents();
    }

    // Starred section
    console.log(`[DEBUG] Starred locations:`, starredLocations);
    if (starredLocations.length) {
      const sec = document.createElement("div");
      const h = document.createElement("div"); h.className = "loc-section-title"; h.textContent = "Starred"; sec.appendChild(h);
      for (const p of starredLocations) {
        const n = pathMap.get(p);
        if (!n) continue; // Skip if location no longer exists
        const baseLabel = n.locationName ? `${n.locationName} (${n.name})` : n.name;
        const row = createLocItem(baseLabel, "⭐", p === lastUsed);
        row.title = p;
        
        // Add actions
        const actions = row.querySelector(".actions") as HTMLElement;
        if (actions) {
          // Add star button (always starred in this section)
          const starBtn = document.createElement("span");
          starBtn.className = "action-btn starred";
          starBtn.textContent = "★";
          starBtn.title = "Remove from starred";
          starBtn.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            toggleStarred(p);
          };
          actions.appendChild(starBtn);
        }
        
        row.onclick = () => {
          if (!socket || myRole !== "DM") return;
          const msg: ClientToServer = { t: "loadLocation", path: p };
          socket.send(JSON.stringify(msg));
          closeLocations();
          addRecent(p);
        };
        sec.appendChild(row);
      }
      locationsTreeEl.appendChild(sec);
    }

    // Recent section (limit to 3)
    if (recentLocations.length) {
      const sec = document.createElement("div");
      const h = document.createElement("div"); h.className = "loc-section-title"; h.textContent = "Recent"; sec.appendChild(h);
      for (const p of recentLocations.slice(0, 3)) {
        const n = pathMap.get(p);
        const baseLabel = n ? (n.locationName ? `${n.locationName} (${n.name})` : n.name) : p;
        const label = baseLabel;
        const row = createLocItem(label, "🕘", p === lastUsed);
        row.title = p;
        
        // Add actions
        const actions = row.querySelector(".actions") as HTMLElement;
        if (actions) {
          // Add star button
          const starBtn = document.createElement("span");
          starBtn.className = `action-btn ${isStarred(p) ? 'starred' : ''}`;
          starBtn.textContent = "★";
          starBtn.title = isStarred(p) ? "Remove from starred" : "Add to starred";
          starBtn.onclick = (e: MouseEvent) => {
            e.stopPropagation();
            toggleStarred(p);
          };
          actions.appendChild(starBtn);
        }
        
        row.onclick = () => {
          if (!socket || myRole !== "DM") return;
          const msg: ClientToServer = { t: "loadLocation", path: p };
          socket.send(JSON.stringify(msg));
          closeLocations();
          addRecent(p);
        };
        sec.appendChild(row);
      }
      locationsTreeEl.appendChild(sec);
    }

    // All section
    const secAll = document.createElement("div");
    const hAll = document.createElement("div"); hAll.className = "loc-section-title"; hAll.textContent = "All"; secAll.appendChild(hAll);
    for (const node of tree) secAll.appendChild(renderNode(node, 0, lastUsed));
    locationsTreeEl.appendChild(secAll);
  }

  function renderNode(node: LocationTreeNode, depth: number, lastUsed?: string): HTMLElement {
    if (node.type === "folder") {
      const open = locationsExpanded.has(node.path);
      const container = document.createElement("div");
      const row = document.createElement("div");
      row.className = "loc-item";
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.setAttribute("data-path", node.path);
      row.setAttribute("data-type", "folder");
      
      const twist = document.createElement("span"); twist.textContent = open ? "▾" : "▸"; twist.className = "twist";
      const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = "📁";
      const name = document.createElement("span"); name.className = "name"; name.textContent = node.name;
      row.appendChild(twist); row.appendChild(icon); row.appendChild(name);
      const spacer = document.createElement("span"); spacer.style.flex = "1"; row.appendChild(spacer);
      
      // No longer adding subfolder creation button - only use the top button
      
      // Action: rename folder (pencil)
      const btnRename = document.createElement("span");
      btnRename.title = "Rename folder";
      btnRename.textContent = "✎";
      btnRename.style.opacity = "0.85";
      btnRename.style.marginLeft = "6px";
      btnRename.style.userSelect = "none";
      btnRename.onclick = (e) => {
        e.stopPropagation();
        if (!socket || myRole !== "DM") return;
        const cur = node.name;
        const nn = prompt("New folder name:", cur || "folder");
        if (!nn) return;
        const newName = nn.replace(/\s+/g, " ").trim();
        if (!newName || /[\\/]/.test(newName)) { alert("Invalid folder name"); return; }
        const msg: ClientToServer = { t: "renameFolder", path: node.path, newName };
        socket.send(JSON.stringify(msg));
      };
      row.appendChild(btnRename);
      
      // Add drag and drop handlers for folders
      setupDragAndDropHandlers(row, node);
      
      const toggle = () => { if (open) locationsExpanded.delete(node.path); else locationsExpanded.add(node.path); requestLocationsList(); };
      row.onclick = toggle; twist.onclick = (e) => { e.stopPropagation(); toggle(); };
      container.appendChild(row);
      if (open && node.children) {
        const childrenWrap = document.createElement("div");
        for (const ch of node.children) childrenWrap.appendChild(renderNode(ch, depth + 1, lastUsed));
        container.appendChild(childrenWrap);
      }
      return container;
    } else {
      const title = node.locationName ? `${node.locationName} (${node.name})` : node.name;
      const row = createLocItem(title, "📄", node.path === lastUsed);
      row.style.paddingLeft = `${8 + depth * 12}px`;
      row.title = node.path;
      row.setAttribute("data-path", node.path);
      row.setAttribute("data-type", "file");
      
      row.onclick = () => {
        if (!socket || myRole !== "DM") return;
        const msg: ClientToServer = { t: "loadLocation", path: node.path };
        socket.send(JSON.stringify(msg));
        closeLocations();
        addRecent(node.path);
      };
      
      // Add actions to the actions container
      const actions = row.querySelector(".actions") as HTMLElement;
      if (actions) {
        // Add star button
        const starBtn = document.createElement("span");
        starBtn.className = `action-btn ${isStarred(node.path) ? 'starred' : ''}`;
        starBtn.textContent = "★";
        starBtn.title = isStarred(node.path) ? "Remove from starred" : "Add to starred";
        starBtn.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          toggleStarred(node.path);
        };
        actions.appendChild(starBtn);
        
        // Add delete button
        const deleteBtn = document.createElement("span");
        deleteBtn.className = "action-btn";
        deleteBtn.textContent = "🗑";
        deleteBtn.title = "Delete";
        deleteBtn.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          if (!socket || myRole !== "DM") return;
          if (!confirm(`Delete location ${title}?`)) return;
          const msg: ClientToServer = { t: "deleteLocation", path: node.path };
          socket.send(JSON.stringify(msg));
        };
        actions.appendChild(deleteBtn);
      }
      
      // Add drag and drop handlers for files
      setupDragAndDropHandlers(row, node);
      
      return row;
    }
  }

  function createLocItem(label: string, iconChar: string, active?: boolean): HTMLDivElement {
    const row = document.createElement("div");
    row.className = "loc-item" + (active ? " active" : "");
    const icon = document.createElement("span"); icon.className = "icon"; icon.textContent = iconChar;
    const name = document.createElement("span"); name.className = "name"; name.textContent = label;
    const spacer = document.createElement("span"); spacer.style.flex = "1"; 
    const actions = document.createElement("div"); actions.className = "actions";
    
    row.appendChild(icon); 
    row.appendChild(name); 
    row.appendChild(spacer);
    row.appendChild(actions);
    return row;
  }
  // Update buttons after welcome determines role
  const observer = new MutationObserver(() => { updateEditorUI(); updateFogModeUI(); });
  observer.observe(document.body, { subtree: true, childList: true });

  // Minimap click handler
  if (minimapCanvas) {
    minimapCanvas.addEventListener("click", (e) => {
      const rect = minimapCanvas!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const canvasWidth = minimapCanvas!.width;
      const canvasHeight = minimapCanvas!.height;
      const mapSize = 50;
      const tileSize = Math.min(canvasWidth / mapSize, canvasHeight / mapSize);
      const offsetX = (canvasWidth - mapSize * tileSize) / 2;
      const offsetY = (canvasHeight - mapSize * tileSize) / 2;
      
      // Convert click position to minimap coordinates
      const minimapX = x - offsetX;
      const minimapY = y - offsetY;
      
      // Convert minimap coordinates to world coordinates
      // Минимарта показывает область от -mapSize/2 до +mapSize/2 в мировых координатах
      const worldX = (minimapX / tileSize) - mapSize / 2;
      const worldY = (minimapY / tileSize) - mapSize / 2;
      
      // Center camera on clicked position
      const targetX = -worldX * CELL;
      const targetY = -worldY * CELL;
      
      world.position.set(targetX + app.screen.width / 2, targetY + app.screen.height / 2);
      drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog();
      drawMinimap();
      updateMinimapViewport();
    });
  }
}

connect();

// Bottom Asset Menu Management
function initializeBottomAssetMenu() {
  const assetMenu = document.getElementById('bottom-asset-menu');
  const assetContent = document.getElementById('asset-content');
  const assetSearch = document.getElementById('asset-search') as HTMLInputElement;
  const categoryTabs = document.querySelectorAll('.asset-category-tab');
  const assetCollapseToggle = document.getElementById('asset-collapse-toggle') as HTMLButtonElement | null;
  const collapseStorageKey = "dnd.assetMenuCollapsed";
  const applyCollapseState = (collapsed: boolean) => {
    document.body.classList.toggle('assets-collapsed', collapsed);
    if (assetCollapseToggle) {
      assetCollapseToggle.setAttribute('aria-expanded', String(!collapsed));
      assetCollapseToggle.setAttribute('data-collapsed', collapsed ? 'true' : 'false');
      assetCollapseToggle.setAttribute('title', collapsed ? 'Expand assets' : 'Collapse assets');
    }
  };
  if (assetCollapseToggle && assetMenu) {
    let collapsed = false;
    try {
      collapsed = localStorage.getItem(collapseStorageKey) === "true";
    } catch {
      collapsed = false;
    }
    applyCollapseState(collapsed);
    assetCollapseToggle.addEventListener('click', () => {
      collapsed = !collapsed;
      applyCollapseState(collapsed);
      try { localStorage.setItem(collapseStorageKey, String(collapsed)); } catch {}
    });
  }
  
  // Asset data organized by categories
  const assetCategories = {
    nature: [
      { id: 'tree', emoji: '🌳', name: 'Tree' },
      { id: 'rock', emoji: '🪨', name: 'Rock' },
      { id: 'bush', emoji: '🌿', name: 'Bush' },
      { id: 'flower', emoji: '🌸', name: 'Flower' },
      { id: 'mushroom', emoji: '🍄', name: 'Mushroom' },
      { id: 'cactus', emoji: '🌵', name: 'Cactus' },
      { id: 'vine', emoji: '🌱', name: 'Vine' },
      { id: 'log', emoji: '🪵', name: 'Log' }
    ],
    fire: [
      { id: 'fire', emoji: '🔥', name: 'Fire' },
      { id: 'torch', emoji: '🕯️', name: 'Torch' },
      { id: 'candle', emoji: '🕯️', name: 'Candle' },
      { id: 'lantern', emoji: '🏮', name: 'Lantern' },
      { id: 'campfire', emoji: '🔥', name: 'Campfire' }
    ],
    weapons: [
      { id: 'sword', emoji: '🗡️', name: 'Sword' },
      { id: 'bow', emoji: '🏹', name: 'Bow' },
      { id: 'axe', emoji: '🪓', name: 'Axe' },
      { id: 'spear', emoji: '🔱', name: 'Spear' },
      { id: 'mace', emoji: '⚔️', name: 'Mace' },
      { id: 'dagger', emoji: '🗡️', name: 'Dagger' },
      { id: 'crossbow', emoji: '🏹', name: 'Crossbow' },
      { id: 'shield', emoji: '🛡️', name: 'Shield' }
    ],
    armor: [
      { id: 'helmet', emoji: '⛑️', name: 'Helmet' },
      { id: 'armor', emoji: '🛡️', name: 'Armor' },
      { id: 'boots', emoji: '👢', name: 'Boots' },
      { id: 'gloves', emoji: '🧤', name: 'Gloves' }
    ],
    containers: [
      { id: 'chest', emoji: '📦', name: 'Chest' },
      { id: 'barrel', emoji: '🛢️', name: 'Barrel' },
      { id: 'crate', emoji: '📦', name: 'Crate' },
      { id: 'bag', emoji: '🎒', name: 'Bag' },
      { id: 'basket', emoji: '🧺', name: 'Basket' },
      { id: 'pot', emoji: '🍯', name: 'Pot' }
    ],
    kitchen: [
      { id: 'cauldron', emoji: '🍲', name: 'Cauldron' },
      { id: 'pan', emoji: '🍳', name: 'Pan' },
      { id: 'plate', emoji: '🍽️', name: 'Plate' },
      { id: 'cup', emoji: '☕', name: 'Cup' },
      { id: 'bottle', emoji: '🍾', name: 'Bottle' },
      { id: 'knife', emoji: '🔪', name: 'Knife' },
      { id: 'fork', emoji: '🍴', name: 'Fork' },
      { id: 'spoon', emoji: '🥄', name: 'Spoon' }
    ],
    food: [
      { id: 'bread', emoji: '🍞', name: 'Bread' },
      { id: 'apple', emoji: '🍎', name: 'Apple' },
      { id: 'meat', emoji: '🥩', name: 'Meat' },
      { id: 'fish', emoji: '🐟', name: 'Fish' },
      { id: 'cheese', emoji: '🧀', name: 'Cheese' },
      { id: 'cake', emoji: '🍰', name: 'Cake' },
      { id: 'pie', emoji: '🥧', name: 'Pie' },
      { id: 'soup', emoji: '🍲', name: 'Soup' },
      { id: 'wine', emoji: '🍷', name: 'Wine' },
      { id: 'beer', emoji: '🍺', name: 'Beer' }
    ],
    clothing: [
      { id: 'hat', emoji: '🎩', name: 'Hat' },
      { id: 'cloak', emoji: '🧥', name: 'Cloak' },
      { id: 'shirt', emoji: '👕', name: 'Shirt' },
      { id: 'pants', emoji: '👖', name: 'Pants' },
      { id: 'dress', emoji: '👗', name: 'Dress' },
      { id: 'shoes', emoji: '👟', name: 'Shoes' },
      { id: 'belt', emoji: '👔', name: 'Belt' }
    ],
    animals: [
      { id: 'cat', emoji: '🐱', name: 'Cat' },
      { id: 'dog', emoji: '🐕', name: 'Dog' },
      { id: 'horse', emoji: '🐴', name: 'Horse' },
      { id: 'bird', emoji: '🐦', name: 'Bird' },
      { id: 'owl', emoji: '🦉', name: 'Owl' },
      { id: 'rat', emoji: '🐀', name: 'Rat' },
      { id: 'spider', emoji: '🕷️', name: 'Spider' },
      { id: 'snake', emoji: '🐍', name: 'Snake' },
      { id: 'frog', emoji: '🐸', name: 'Frog' },
      { id: 'butterfly', emoji: '🦋', name: 'Butterfly' },
      { id: 'bee', emoji: '🐝', name: 'Bee' },
      { id: 'fish_animal', emoji: '🐠', name: 'Fish' }
    ],
    insects: [
      { id: 'ant', emoji: '🐜', name: 'Ant' },
      { id: 'fly', emoji: '🪰', name: 'Fly' },
      { id: 'mosquito', emoji: '🦟', name: 'Mosquito' },
      { id: 'beetle', emoji: '🪲', name: 'Beetle' },
      { id: 'dragonfly', emoji: '🦟', name: 'Dragonfly' }
    ],
    treasure: [
      { id: 'coins', emoji: '🪙', name: 'Coins' },
      { id: 'gem', emoji: '💎', name: 'Gem' },
      { id: 'ring', emoji: '💍', name: 'Ring' },
      { id: 'necklace', emoji: '📿', name: 'Necklace' },
      { id: 'crown', emoji: '👑', name: 'Crown' },
      { id: 'treasure', emoji: '💰', name: 'Treasure' }
    ],
    magic: [
      { id: 'book', emoji: '📖', name: 'Book' },
      { id: 'scroll', emoji: '📜', name: 'Scroll' },
      { id: 'potion', emoji: '🧪', name: 'Potion' },
      { id: 'crystal', emoji: '🔮', name: 'Crystal' },
      { id: 'wand', emoji: '🪄', name: 'Wand' },
      { id: 'orb', emoji: '🔮', name: 'Orb' }
    ],
    tools: [
      { id: 'hammer', emoji: '🔨', name: 'Hammer' },
      { id: 'pickaxe', emoji: '⛏️', name: 'Pickaxe' },
      { id: 'shovel', emoji: '🪣', name: 'Shovel' },
      { id: 'rope', emoji: '🪢', name: 'Rope' },
      { id: 'key', emoji: '🗝️', name: 'Key' },
      { id: 'lock', emoji: '🔒', name: 'Lock' }
    ],
    furniture: [
      { id: 'chair', emoji: '🪑', name: 'Chair' },
      { id: 'table', emoji: '🪑', name: 'Table' },
      { id: 'bed', emoji: '🛏️', name: 'Bed' },
      { id: 'stool', emoji: '🪑', name: 'Stool' },
      { id: 'bench', emoji: '🪑', name: 'Bench' }
    ],
    paths: [
      { id: 'path', emoji: '🛤️', name: 'Path' },
      { id: 'bridge', emoji: '🌉', name: 'Bridge' },
      { id: 'stairs', emoji: '🪜', name: 'Stairs' }
    ],
    structures: [
      { id: 'wall', emoji: '🧱', name: 'Stone Wall' },
      { id: 'wall-stone', emoji: '🏰', name: 'Fortified Wall' },
      { id: 'wall-wood', emoji: '🪵', name: 'Wooden Palisade' },
      { id: 'wall-ruined', emoji: '🧱', name: 'Broken Wall' },
      { id: 'window', emoji: '🪟', name: 'Standard Window' },
      { id: 'window-stained', emoji: '🌈', name: 'Stained Glass' },
      { id: 'window-barred', emoji: '🪟', name: 'Barred Window' },
      { id: 'window-observation', emoji: '🔭', name: 'Observation Slit' },
      { id: 'door', emoji: '🚪', name: 'Wooden Door' },
      { id: 'door-iron', emoji: '🚪', name: 'Iron Door' },
      { id: 'door-arched', emoji: '🚪', name: 'Arched Doorway' },
      { id: 'door-portcullis', emoji: '🛡️', name: 'Portcullis Gate' }
    ]
  };

  let currentCategory = 'all';
  let currentSearchTerm = '';

  function renderAssets() {
    if (!assetContent) return;

    let assetsToShow: any[] = [];
    
    if (currentCategory === 'all') {
      // Show all assets
      Object.values(assetCategories).forEach(categoryAssets => {
        assetsToShow.push(...categoryAssets);
      });
    } else {
      // Show specific category
      assetsToShow = assetCategories[currentCategory as keyof typeof assetCategories] || [];
    }

    // Filter by search term
    if (currentSearchTerm) {
      assetsToShow = assetsToShow.filter(asset => 
        asset.name.toLowerCase().includes(currentSearchTerm.toLowerCase()) ||
        asset.id.toLowerCase().includes(currentSearchTerm.toLowerCase())
      );
    }

    // Group by category for display
    const groupedAssets: { [key: string]: any[] } = {};
    assetsToShow.forEach(asset => {
      // Find which category this asset belongs to
      let category = 'other';
      for (const [catName, catAssets] of Object.entries(assetCategories)) {
        if (catAssets.some(a => a.id === asset.id)) {
          category = catName;
          break;
        }
      }
      
      if (!groupedAssets[category]) {
        groupedAssets[category] = [];
      }
      groupedAssets[category].push(asset);
    });

    // Render the assets
    assetContent.innerHTML = '';
    
    Object.entries(groupedAssets).forEach(([category, assets]) => {
      const section = document.createElement('div');
      section.className = 'asset-section';
      
      const title = document.createElement('div');
      title.className = 'asset-section-title';
      title.textContent = getCategoryDisplayName(category);
      section.appendChild(title);
      
      const grid = document.createElement('div');
      grid.className = 'asset-grid';
      
      assets.forEach(asset => {
        const item = document.createElement('div');
        item.className = 'asset-item';
        item.dataset.assetId = asset.id;
        if (asset.id === selectedAssetKind) {
          item.classList.add('selected');
        }
        
        const emoji = document.createElement('div');
        emoji.className = 'asset-emoji';
        emoji.textContent = asset.emoji;
        
        const name = document.createElement('div');
        name.className = 'asset-name';
        name.textContent = asset.name;
        
        item.appendChild(emoji);
        item.appendChild(name);
        
        // Add click handler
        item.addEventListener('click', () => {
          selectAsset(asset.id);
        });
        
        grid.appendChild(item);
      });
      
      section.appendChild(grid);
      assetContent.appendChild(section);
    });
  }

  function getCategoryDisplayName(category: string): string {
    const names: { [key: string]: string } = {
      nature: 'Nature & Plants',
      fire: 'Fire & Lighting',
      weapons: 'Weapons',
      armor: 'Armor',
      containers: 'Chests & Containers',
      kitchen: 'Kitchen Items',
      food: 'Food & Drinks',
      clothing: 'Clothing',
      animals: 'Animals',
      insects: 'Insects',
      treasure: 'Treasure & Coins',
      magic: 'Books & Magic',
      tools: 'Tools',
      furniture: 'Furniture',
      paths: 'Paths & Trails',
      structures: 'Walls, Doors & Windows',
      other: 'Miscellaneous'
    };
    return names[category] || category;
  }

  function selectAsset(assetId: string) {
    // Remove previous selection
    document.querySelectorAll('.asset-item.selected').forEach(item => {
      item.classList.remove('selected');
    });
    
    // Add selection to clicked item
    const selectedItem = document.querySelector(`[data-asset-id="${assetId}"]`);
    if (selectedItem) {
      selectedItem.classList.add('selected');
    }
    
    // Set the selected asset for placement
    selectedAssetKind = assetId;
    selectedFloorKind = null;
    selectedTokenKind = null;
    editorMode = 'paint';
    
    // Update UI to show paint mode
    // UI will be updated by the existing updateEditorUI calls in event handlers
    updateEditorUI();
  }

  // Category tab handlers
  categoryTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      // Remove active class from all tabs
      categoryTabs.forEach(t => t.classList.remove('active'));
      
      // Add active class to clicked tab
      tab.classList.add('active');
      
      // Update current category
      currentCategory = tab.getAttribute('data-category') || 'all';
      
      // Re-render assets
      renderAssets();
    });
  });

  // Search handler
  if (assetSearch) {
    assetSearch.addEventListener('input', (e) => {
      currentSearchTerm = (e.target as HTMLInputElement).value;
      renderAssets();
    });
  }

  // Initial render
  renderAssets();
}

// Initialize the bottom asset menu when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initializeBottomAssetMenu();
    initializeAuth();
  });
} else {
  initializeBottomAssetMenu();
  initializeAuth();
}

function setupUserDropdown() {
  const userIcon = document.getElementById('user-icon');
  const userDropdown = document.getElementById('user-dropdown');
  const logoutAction = document.getElementById('logout-action');
  const profileAction = document.getElementById('profile-action');
  const adminPanel = document.getElementById('admin-panel');

  console.log('Setting up user dropdown:', { userIcon, userDropdown, logoutAction, adminPanel, profileAction });

  if (!userIcon || !userDropdown || !logoutAction) {
    console.log('Missing required elements for user dropdown');
    return;
  }

  // Toggle dropdown
  userIcon.addEventListener('click', () => {
    const isOpen = userDropdown.classList.contains('open');
    if (isOpen) {
      userDropdown.classList.remove('open');
      userDropdown.setAttribute('aria-hidden', 'true');
      userIcon.setAttribute('aria-expanded', 'false');
    } else {
      userDropdown.classList.add('open');
      userDropdown.setAttribute('aria-hidden', 'false');
      userIcon.setAttribute('aria-expanded', 'true');
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!userIcon.contains(e.target as Node) && !userDropdown.contains(e.target as Node)) {
      userDropdown.classList.remove('open');
      userDropdown.setAttribute('aria-hidden', 'true');
      userIcon.setAttribute('aria-expanded', 'false');
    }
  });

  if (profileAction) {
    profileAction.addEventListener('click', () => {
      userDropdown.classList.remove('open');
      userDropdown.setAttribute('aria-hidden', 'true');
      userIcon.setAttribute('aria-expanded', 'false');
      openProfileModal();
    });
  }

  // Logout functionality
  logoutAction.addEventListener('click', () => {
    console.log('Logout button clicked');
    console.log('Socket state:', socket ? socket.readyState : 'no socket');
    
    // Close dropdown first to avoid aria-hidden issues
    userDropdown.classList.remove('open');
    userDropdown.setAttribute('aria-hidden', 'true');
    userIcon.setAttribute('aria-expanded', 'false');
    
    if (socket && socket.readyState === WebSocket.OPEN) {
      const logoutMsg: ClientToServer = { t: "logout" };
      try { 
        socket.send(JSON.stringify(logoutMsg)); 
        console.log('Logout message sent to server:', logoutMsg);
        if (logoutTimeout) {
          clearTimeout(logoutTimeout);
          logoutTimeout = null;
        }
        logoutTimeout = setTimeout(() => {
          console.warn('[DEBUG] Logout server response timeout, clearing session locally');
          authState = { isAuthenticated: false };
          currentUser = null;
          clearSession();
          showLoginScreen();
          closeUsersPanel();
        }, 3000);
      } catch (error) {
        console.error('Error sending logout message:', error);
      }
    } else {
      console.log('No WebSocket connection, clearing session locally');
      // If no WebSocket connection, just clear session and show login
      authState = { isAuthenticated: false };
      currentUser = null;
      clearSession();
      showLoginScreen();
      closeUsersPanel();
      if (logoutTimeout) {
        clearTimeout(logoutTimeout);
        logoutTimeout = null;
      }
    }
  });

  // Admin panel functionality
  if (adminPanel) {
    console.log('Admin panel element found, adding event listener');
    adminPanel.addEventListener('click', () => {
      console.log('Admin panel button clicked');
      
      // Close dropdown first to avoid aria-hidden issues
      userDropdown.classList.remove('open');
      userDropdown.setAttribute('aria-hidden', 'true');
      userIcon.setAttribute('aria-expanded', 'false');
      
      // Show users panel (admin functionality)
      openUsersPanel();
    });
  } else {
    console.log('Admin panel element not found');
  }
}

function updateUserDropdown() {
  const userRole = document.getElementById('user-role');
  const userName = document.getElementById('user-name');
  const userEmail = document.getElementById('user-email');
  const adminPanel = document.getElementById('admin-panel');

  console.log('updateUserDropdown called with currentUser:', currentUser);

  if (!currentUser || !userRole || !userName || !userEmail) {
    console.log('Missing elements or currentUser:', { currentUser, userRole, userName, userEmail });
    return;
  }

  // Update user info
  userRole.textContent = currentUser.role === 'master' ? 'Master' : 'User';
  userName.textContent = currentUser.username;
  userEmail.textContent = currentUser.email;

  // Show/hide admin panel based on role
  if (adminPanel) {
    adminPanel.style.display = currentUser.role === 'master' ? 'flex' : 'none';
    console.log('Admin panel display set to:', adminPanel.style.display, 'for role:', currentUser.role);
  }
}

function initializeAuth() {
  // Setup forms
  setupLoginForm();
  setupFirstUserForm();
  setupUserManagement();
  setupUserDropdown();
  setupProfileModal();
  
  // Setup copy password functionality
  const copyPasswordBtn = document.getElementById('copy-password');
  if (copyPasswordBtn) {
    copyPasswordBtn.addEventListener('click', () => {
      const passwordInput = document.getElementById('generated-password') as HTMLInputElement;
      if (passwordInput) {
        passwordInput.select();
        document.execCommand('copy');
        copyPasswordBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyPasswordBtn.textContent = 'Copy';
        }, 2000);
      }
    });
  }
  
  // Don't show any screen initially - wait for server response
}

function centerOn(v: Vec2) {
  const s = world.scale.x || 1;
  const pos = { x: v.x * CELL + CELL / 2, y: v.y * CELL + CELL / 2 };
  const cx = app.screen.width / 2 - pos.x * s;
  const cy = app.screen.height / 2 - pos.y * s;
  world.position.set(cx, cy);
  drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog();
  drawMinimap();
  updateMinimapViewport();
}

function centerOnMyToken() {
  if (myTokenId) {
    const tok = tokens.get(myTokenId);
    if (tok) { centerOn(tok.pos); return; }
  }
  // Fallback: center on level spawn if available
  if (currentLocation && levelId) {
    const lvl = currentLocation.levels.find(l => l.id === levelId);
    if (lvl) { centerOn(lvl.spawnPoint); return; }
  }
  // Last resort: center on map middle
  centerOn({ x: 5, y: 5 });
}

// ------ Camera: pan (LMB drag on empty space) & zoom (wheel) ------
type PanState = { startX: number; startY: number; worldX: number; worldY: number } | null;
let panning: PanState = null;
// Start panning when pressing on stage background (tokens stopPropagation already)

app.stage.on("pointerdown", (e: any) => {
  // ignore if token drag already initiated
  if (dragging) return;
  // only left button
  if (typeof e.button === "number" && e.button !== 0) return;
  const p = world.toLocal(e.global);
  const cell = snapToGrid(p.x, p.y);
  if (myRole === "DM") {
    const brushActive = BRUSH_MODES.includes(editorMode);
    lastPointerDownDidAct = false;
    if (brushActive) {
      document.body.style.cursor = "crosshair";
      painting = true;
      lastPaintKey = null;
      lastPaintCell = null;
      const result = applyBrushAtCell(cell);
      if (result.touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
      if (result.acted) lastPointerDownDidAct = true;
      lastPaintCell = cell;
      lastPaintKey = cellKey(cell);
      e.stopPropagation?.();
      return;
    }
    if (editorMode === "spawnToken") {
      document.body.style.cursor = "crosshair";
      if (socket && levelId && selectedTokenKind) {
        const kind = selectedTokenKind;
        const msg: ClientToServer = { t: "spawnToken", kind, levelId, pos: cell };
        socket.send(JSON.stringify(msg));
        lastPointerDownDidAct = true;
        // reset tool back to cursor after one placement
        selectedTokenKind = null;
        editorMode = "cursor";
        document.body.style.cursor = dragging ? "grabbing" : "default";
      }
      e.stopPropagation?.();
      return;
    }
    painting = false;
    lastPaintCell = null;
    lastPaintKey = null;
  }
  panning = { startX: e.global.x, startY: e.global.y, worldX: world.position.x, worldY: world.position.y };
  document.body.style.cursor = "grabbing";
});
// Fallback for single-click taps to reliably apply 1x1 (and other) brush actions even if pointerdown didn't apply
app.stage.on("pointertap", (e: any) => {
  if (myRole !== "DM") return;
  // Only handle paint tool here to avoid duplicating other actions; also avoid duplicates if pointerdown already acted
  if (editorMode !== "paint" || !selectedFloorKind || lastPointerDownDidAct) return;
  const lvlTap = resolveActiveLevel();
  if (!lvlTap) return;
  if (!levelId) levelId = lvlTap;
  const p = world.toLocal(e.global);
  const cell = snapToGrid(p.x, p.y);
  const result = applyBrushAtCell(cell);
  if (result.touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
  if (result.acted) lastPointerDownDidAct = true;
  lastPaintCell = cell;
  lastPaintKey = cellKey(cell);
});
app.stage.on("pointermove", (e: any) => {
  if (painting) {
    const p = world.toLocal(e.global);
    const cell = snapToGrid(p.x, p.y);
    const key = cellKey(cell);
    if (key === lastPaintKey) return;
    const prev = lastPaintCell;
    const steps = prev ? cellsBetween(prev, cell) : [cell];
    if (steps.length === 0) {
      lastPaintCell = cell;
      lastPaintKey = key;
      return;
    }
    let touchedFloor = false;
    let acted = false;
    for (const step of steps) {
      const result = applyBrushAtCell(step);
      if (result.touchedFloor) touchedFloor = true;
      if (result.acted) acted = true;
    }
    if (touchedFloor) { drawFloor(); drawGrid(); drawFog(); }
    if (acted) lastPointerDownDidAct = true;
    lastPaintCell = cell;
    lastPaintKey = key;
    return;
  }
  if (!panning) return;
  const dx = e.global.x - panning.startX;
  const dy = e.global.y - panning.startY;
  world.position.set(panning.worldX + dx, panning.worldY + dy);
  drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog();
  drawMinimap();
  updateMinimapViewport();
});
function endPan() {
  if (painting) {
    painting = false;
    lastPaintKey = null;
    lastPaintCell = null;
    document.body.style.cursor = "default";
  }
  if (!panning) return;
  panning = null;
  document.body.style.cursor = "default";
}
app.stage.on("pointerup", endPan);
app.stage.on("pointerupoutside", endPan);

// Zoom with wheel, focus on cursor
const MIN_ZOOM = 0.25, MAX_ZOOM = 4.0, ZOOM_STEP = 0.05;  // Увеличиваем диапазон и делаем шаги более точными
const canvasEl: HTMLCanvasElement = (app as any).view || (app as any).canvas;
canvasEl.addEventListener("wheel", (ev) => {
  const isPinchZoom = ev.ctrlKey;
  const deltaMagnitude = Math.hypot(ev.deltaX, ev.deltaY);
  
  // Улучшенная логика определения жестов трекпада
  const isTrackpadPan = !isPinchZoom && 
    ev.deltaMode === WheelEvent.DOM_DELTA_PIXEL && 
    deltaMagnitude < 60 &&  // Увеличиваем порог для более плавного панорамирования
    (Math.abs(ev.deltaY) > Math.abs(ev.deltaX) * 2 || Math.abs(ev.deltaX) > Math.abs(ev.deltaY) * 2);  // Поддержка как вертикального, так и горизонтального панорамирования
  
  const isTrackpadZoom = !isPinchZoom && 
    ev.deltaMode === WheelEvent.DOM_DELTA_PIXEL && 
    deltaMagnitude >= 60;  // Большие жесты для масштабирования
  
  if (isTrackpadPan) {
    ev.preventDefault();
    world.position.set(world.position.x - ev.deltaX, world.position.y - ev.deltaY);
    drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog();
    drawMinimap();
    updateMinimapViewport();
    return;
  }
  
  // Масштабирование (трекпад или колесо мыши)
  if (isTrackpadZoom || isPinchZoom || ev.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) {
    ev.preventDefault();
    const oldS = world.scale.x || 1;
    
    // Для трекпада используем более плавное масштабирование
    let zoomFactor = 1.0;
    if (isTrackpadZoom) {
      // Более плавное масштабирование для трекпада
      zoomFactor = 1 + (ev.deltaY * 0.01);
    } else {
      // Обычное масштабирование для колеса мыши
      const direction = ev.deltaY !== 0 ? -Math.sign(ev.deltaY) : ev.deltaX !== 0 ? -Math.sign(ev.deltaX) : 0;
      if (!direction) return;
      zoomFactor = 1 + direction * ZOOM_STEP;
    }
    
    let s = oldS * zoomFactor;
    s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s));
    if (Math.abs(s - oldS) < 0.001) return;
    
    const sx = ev.clientX; const sy = ev.clientY;
    // world coords under cursor before zoom
    const wx = (sx - world.position.x) / oldS;
    const wy = (sy - world.position.y) / oldS;
    world.scale.set(s);
    // adjust position so the same world point stays under cursor
    world.position.set(sx - wx * s, sy - wy * s);
    drawFloor(); drawGrid(); drawWalls(); drawObjects(); drawAssets(); drawFog();
    drawMinimap();
    updateMinimapViewport();
  }
}, { passive: false });
