# Repository Guidelines

## Project Structure
- `upload-server/`: Rust Rocket server plus frontend JS (`static/js/`), templates (`templates/`), and tests (`tests/`, `e2e/`).
- `update-image.py`: Python script that flashes pre-dithered images to the Inky display.
- `yocto/`: Yocto/KAS image build system and flash tooling (`scripts/`).
- `yocto/scripts/`: build, SD card flash, and A/B update helpers; the app unit is `inky-soup-server.service`.
- `upload-server/static/images/`: originals plus derived outputs (`cache/`, `thumbs/`, `dithered/`).

## Build, Test, and Development Commands
- `cd upload-server && cargo run`: run the local server on port 8000.
- `cd upload-server && cargo test --locked`: Rust tests.
- `python3 -m unittest discover -s tests -v`: display image decoding tests (Pillow and NumPy required).
- `cd upload-server && npm ci`: install the locked JS dependencies.
- `cd upload-server && ./run-tests.sh`: lint + JS unit + Docker E2E suite; removes the Docker test volume on exit.
- `cd upload-server && npm run lint|lint:fix|test|test:e2e`: targeted JS checks.
- `git submodule update --init --recursive`: initialize the shared `yocto/pi-base` helpers.
- `cd yocto && npm ci`: install deployment-helper dependencies.
- From `yocto/`, use `npm run build:zero1` or `npm run build:zero2` in a compatible KAS/Yocto environment.
- From `yocto/`, use `npm run flash:zero1` or `npm run flash:zero2` to flash an SD card and inject SSH/WiFi configuration.
- `cd yocto && npm run test:usb`: USB regression tests without hardware.
- See `yocto/README.md` for A/B updater prerequisites and boot partition limitations.

## Coding Style & Naming Conventions
- JavaScript conventions live in `JS_STYLE_GUIDE.md`.
- Prefer `async/await`, named exports only, and the module hierarchy `core/ -> services/ -> ui/`.
- Centralize state in `upload-server/static/js/core/state.js`; cache DOM lookups in `core/dom.js`.
- Cache, thumb, and dithered files are always PNG and named `{original}.png`.

## Testing Guidelines
- Unit tests: `upload-server/tests/**/*.test.js` (Vitest) and Rust source modules.
- E2E: `upload-server/e2e/*.spec.js` (Playwright). Local config starts its server; remote config requires one already running. Use disposable test data.
- Use `npm run test:coverage` when assessing coverage.
- GitHub Actions runs lint, JS/Rust unit tests, Python display decoding tests, and USB checks. E2E, full Yocto builds, and physical display tests are separate.

## Commit & Pull Request Guidelines
- Commit messages are short, imperative, sentence case (e.g., “Add …”, “Fix …”).
- PRs should include: summary, tests run, and linked issues when relevant.
- Include screenshots for UI changes and note target hardware (Pi Zero W vs Pi Zero 2 W) for display/Yocto changes.

## Agent Notes
- Work in the existing standalone checkout; do not create linked worktrees unless requested.
- See `CLAUDE.md` for architecture, pipeline details, and deployment notes.
