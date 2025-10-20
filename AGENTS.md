# Repository Guidelines

## Project Structure & Module Organization
- **Root**: npm workspaces configuration with shared TypeScript settings in `tsconfig.base.json`
- **`packages/client/`**: PixiJS-powered frontend with Vite build system
  - Entry point: `src/main.ts` (2700+ lines of client logic)
  - Static assets: `index.html` with comprehensive UI
  - Build output: `dist/` directory
- **`packages/server/`**: Node.js WebSocket backend
  - Main server: `src/index.ts` (1300+ lines of server logic)
  - Data persistence: `data/locations/` directory for JSON maps
  - Build output: `dist/` directory
- **`packages/shared/`**: Cross-package type definitions and protocols
  - Types: `src/types.ts` (Token, Asset, Location, Event definitions)
  - Protocol: `src/protocol.ts` (WebSocket message schemas)
  - Build output: `dist/` with TypeScript declarations

## Build, Test, and Development Commands

### Development
- `npm run dev` — запуск сервера (tsx) и клиента (Vite) одновременно для разработки
- `npm run -w @dnd/server dev` — только сервер в режиме watch (используйте `PORT=8090` для множественных экземпляров)
- `npm run -w @dnd/client dev` — только клиент на порту Vite для отладки frontend

### Production
- `npm run build` — сборка всех пакетов (shared → server → client), обязательна перед публикацией
- `npm run start` — запуск продакшн сборок для тестирования
- `npm run format` — форматирование кода Prettier, запускать перед коммитом

## Coding Style & Naming Conventions

### TypeScript & JavaScript
- **Node.js**: версия 18+ обязательна, используйте ES модули
- **TypeScript**: строгий режим включен, избегайте `any` без необходимости
- **Форматирование**: Prettier с настройками по умолчанию (2 пробела, двойные кавычки в JSON)

### Именование
- **Типы и enum**: PascalCase (`Token`, `GameSnapshot`)
- **Файлы**: kebab-case (`level-editor.ts`, `fog-manager.ts`)
- **Компоненты**: PascalCase (`CharacterPanel`, `LocationTree`)
- **Переменные и функции**: camelCase (`currentLocation`, `drawTokens`)

### Архитектура
- **Shared логика**: размещайте в `@dnd/shared`, избегайте cross-import между пакетами
- **Модули**: размещайте рядом с потребителями, избегайте глубокой вложенности
- **Импорты**: используйте алиасы `@dnd/shared` вместо относительных путей

## Testing Guidelines

### Текущее состояние
- **Автоматические тесты**: отсутствуют, используется ручное тестирование
- **Валидация**: запускайте `npm run build` + `npm run dev` для проверки изменений
- **Сценарии**: воспроизводите конкретные случаи использования в dev режиме

### Добавление тестов
- **Клиент**: используйте Vitest, размещайте в `packages/client/__tests__/`
- **Сервер**: используйте Node.js встроенный `node --test`, размещайте в `packages/server/__tests__/`
- **Документация**: опишите runner и ожидания в PR

### Ручное тестирование
- **Функциональность**: проверяйте все затронутые фичи
- **Интеграция**: тестируйте взаимодействие клиент-сервер
- **Производительность**: проверяйте на больших картах с множеством объектов

## Commit & Pull Request Guidelines

### Коммиты
- **Формат**: Conventional Commits с префиксами (`feat`, `fix`, `chore`, `refactor`)
- **Скоупы**: используйте `feat(client): add fog tools` для группировки
- **Длина**: заголовок до 72 символов, детали в теле коммита
- **Ссылки**: указывайте issue ID в теле коммита

### Pull Requests
- **Мотивация**: объясните зачем нужны изменения
- **Тестирование**: опишите как тестировали изменения
- **Миграции**: упомяните изменения в структуре данных
- **Скриншоты**: добавьте до/после для UI изменений
- **Конфигурация**: явно укажите изменения портов, директорий, переменных окружения

## Security & Configuration Tips

### Безопасность
- **Секреты**: храните в локальных `.env` файлах, не коммитьте их
- **Валидация**: проверяйте все данные от клиента перед сохранением
- **Типы**: используйте shared type guards для новых сообщений
- **Роли**: проверяйте права доступа (DM vs Player) на сервере

### Конфигурация
- **Порты**: сервер использует `PORT` и `MAX_PORT` переменные
- **Данные**: карты сохраняются в `LOCATIONS_DIR` (по умолчанию `packages/server/data/locations`)
- **Бэкапы**: никогда не запускайте против продакшн директории без бэкапов
- **Множественные экземпляры**: используйте разные порты для параллельной разработки

## Реализованный функционал

### Клиент (packages/client)
- **PixiJS рендеринг**: 2D графика с поддержкой слоев и z-index
- **Интерактивные инструменты**: кисти, ластики, покраска пола, размещение ассетов
- **Управление токенами**: создание, редактирование, перемещение, контекстные меню
- **Туман войны**: автоматическое и ручное управление видимостью
- **Навигация**: панорамирование, зум, мини-карта
- **UI компоненты**: панели инструментов, редактор характеристик, дерево локаций
- **WebSocket клиент**: подключение, переподключение, обработка событий

### Сервер (packages/server)
- **WebSocket сервер**: обработка подключений, роли, авторизация
- **Управление состоянием**: токены, ассеты, туман войны, покраска пола
- **Файловая система**: сохранение/загрузка карт, управление папками
- **Валидация**: проверка прав доступа, валидация данных от клиента
- **Автосохранение**: автоматическое сохранение изменений
- **Процедурная генерация**: генерация стен и пола на основе seed

### Shared (packages/shared)
- **Типы данных**: Token, Asset, Location, Event, GameSnapshot
- **WebSocket протокол**: ClientToServer и ServerToClient сообщения
- **Валидация**: type guards для проверки данных
- **События**: система событий для синхронизации состояния
