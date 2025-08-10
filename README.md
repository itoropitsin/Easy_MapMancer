# DnD Tabletop (MVP)

Веб-приложение «стол» для DnD: генерация карт, токены, туман войны и синхронная игра Master/Players в браузере.

## Стек
- Клиент: TypeScript + PixiJS v8 + Vite
- Сервер: Node.js + ws (WebSocket)
- Общие типы/протокол: пакет `@dnd/shared`

Требования: Node.js >= 18, npm >= 9.

## Структура репозитория
```
.
├─ packages/
│  ├─ client/           # Vite + PixiJS клиент
│  │  ├─ index.html
│  │  └─ src/
│  │     └─ main.ts    # подключение к WS, рендер сетки и токенов
│  ├─ server/           # Node + ws сервер-авторитет
│  │  └─ src/
│  │     └─ index.ts   # WS /ws, события, snapshot, базовые права
│  └─ shared/           # Общие типы и протокол сообщений
│     └─ src/
│        ├─ types.ts
│        └─ protocol.ts
├─ package.json          # npm workspaces, общие скрипты
├─ tsconfig.base.json    # базовые TS-настройки и алиасы
└─ .gitignore
```

## Быстрый старт (Dev)
1) Установка зависимостей в корне:
```
npm install
```
2) Запуск клиента и сервера параллельно:
```
npm run dev
```
3) Открыть клиент:
- http://localhost:5173/?inv=dm-local — зайти как DM (Мастер)
- http://localhost:5173/?inv=pl-local — зайти как Player (Игрок)

Сервер доступен по ws://localhost:8080/ws (HTTP проверка: http://localhost:8080/ возвращает 200).

Управление: стрелки перемещают ваш токен по сетке (синхронно видно во всех вкладках).

## Скрипты
- `npm run dev` — старт серверной и клиентской частей одновременно
- `npm run server:dev` — только сервер (watch)
- `npm run client:dev` — только клиент (Vite)
- `npm run build` — сборка всех пакетов

## Протокол (черновик)
- Client → Server:
  - `{ t: "join", name?, invite? }`
  - `{ t: "moveToken", tokenId, pos:{x,y}, levelId }`
- Server → Client:
  - `{ t: "welcome", playerId, role, snapshot }`
  - `{ t: "statePatch", events: [...] }`
  - `{ t: "error", message }`

События (часть):
- `tokenSpawned { token }`
- `tokenMoved { tokenId, pos, levelId }`

## MVP-план ближайших итераций
- Генерация пола/стен/объектов (чанки 32×32, seed‑детерминированно)
- Туман войны (глобальная маска, авто по радиусу; затем LOS по стенам)
- Режимы перемещения: свободно и через аппрув DM
- Многоуровневость и спавн
- Сохранение/загрузка локаций (JSON)

## Заметки
- Алиасы TS: `@dnd/shared` указывает на `packages/shared/src/` (dev)
- Граница карты сейчас условная (±50 клеток) и проверяется на сервере
- Для роли DM используйте инвайт, начинающийся с `dm-` (например, `dm-local`)

## Лицензия
MIT
