# Repository Guidelines

## Project Structure
- `upload-server/`: Rust Rocket server plus frontend JS (`static/js/`), templates (`templates/`), and tests (`tests/`, `e2e/`).
- `update-image.py`: Python script that flashes pre-dithered images to the Inky display.
- `yocto/`: Yocto/KAS image build system and flash tooling (`scripts/`).
- `deploy.sh`, `deploy-sdcard.sh`, `setup-crosscompile.sh`: deployment helpers; `inky-soup.service` is the systemd unit.
- `upload-server/static/images/`: originals plus derived outputs (`cache/`, `thumbs/`, `dithered/`).

## Build, Test, and Development Commands
- `cd upload-server && cargo run`: run the local server on port 8000.
- `cd upload-server && cargo test`: Rust tests.
- `cd upload-server && npm install`: install JS deps (first time).
- `cd upload-server && ./run-tests.sh`: lint + unit + E2E suite.
- `cd upload-server && npm run lint|lint:fix|test|test:e2e`: targeted JS checks.
- `./setup-crosscompile.sh`: install `cross` + targets; `INKY_SOUP_IP=<host> ./deploy.sh` ships to a Pi.
- `cd yocto && npm run build|flash|yolo`: build and flash the Yocto image.

## Coding Style & Naming Conventions
- JavaScript conventions live in `JS_STYLE_GUIDE.md`.
- Prefer `async/await`, named exports only, and the module hierarchy `core/ -> services/ -> ui/`.
- Centralize state in `upload-server/static/js/core/state.js`; cache DOM lookups in `core/dom.js`.
- Cache, thumb, and dithered files are always PNG and named `{original}.png`.

## Testing Guidelines
- Unit tests: `upload-server/tests/*.test.js` (Vitest).
- E2E: `upload-server/e2e/*.spec.js` (Playwright); requires a running server.
- Use `npm run test:coverage` when assessing coverage.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, sentence case (e.g., “Add …”, “Fix …”).
- PRs should include: summary, tests run, and linked issues when relevant.
- Include screenshots for UI changes and note target hardware (Pi Zero W vs Pi Zero 2 W) for display/Yocto changes.

## Agent Notes
- See `CLAUDE.md` for architecture, pipeline details, and deployment notes.
