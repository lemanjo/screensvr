# screensvr

**Beautiful screens for idle devices.**

screensvr is an open-source, self-hosted platform that transforms idle screens into beautiful, customizable ambient displays.

Inspired by how smartwatches use downloadable watch faces, screensvr brings the same experience to wall-mounted tablets, smart-home displays, monitors, and other browser-enabled devices.

Users can browse, install, and switch between different **screen faces**, each offering a unique visual experience. A face might feature an elegant analog clock over an animated gradient, a minimalist digital clock, generative artwork, or a dynamic display that responds to weather and smart-home data.

Each face is independently developed and customizable, allowing users to personalize colors, animations, clock styles, layouts, and displayed information.

## First release: v0.1

The first release includes a management UI, multiple independent displays, two
bundled clock faces, live previews and settings updates, and **local face ZIP
installation**. Configuration and installed packages stay on your server.

### Run with Docker

```sh
docker compose up --build -d
```

Open **http://localhost:3000**, create an administrator password, and add a display.
Open its private display link in the tablet or kiosk browser. Complete first-run
setup on a trusted network: the first person to finish setup claims the server.

The named `screensvr-data` volume persists settings, authentication, and installed
faces. See [deployment and backups](docs/deployment.md) before exposing the server
or upgrading it.

### Run locally

Requires Node.js 24 LTS.

```sh
npm ci
npm run build
npm start
```

For development, run `npm run dev` and open **http://localhost:5173**. Vite proxies
the API and face assets to Fastify on port 3000. Do not use the development server
as a production deployment.

### Install your own face

In **Face library**, choose **Install ZIP**. Only install packages from sources
you trust: faces contain executable JavaScript, and the v0.1 sandbox is defense
in depth, not a promise that hostile code is safe.

See the [face developer guide](docs/faces.md) and the
[framework-free example](examples/paper/). No server rebuild is required to
install a face.

## Product direction

The following describes the broader vision. Scheduling, Home Assistant,
community discovery, and automatic updates are **not included in v0.1**.

- **Downloadable screen faces:** Discover, install, and switch between beautiful community-created designs, just like smartwatch watch faces.
- **Fully customizable:** Each face provides its own configuration options for colors, styles, animations, and information.
- **Central management:** A modern web interface for managing faces, configuring devices, and previewing changes.
- **Multi-device support:** Manage multiple displays, each with its own active face and settings.
- **Smart scheduling:** Automatically change faces based on time, sunrise, sunset, or custom conditions.
- **Home Assistant integration:** Optionally display live smart-home information such as temperature, weather, or energy consumption.
- **Open plugin ecosystem:** Developers can build and distribute their own faces using modern web technologies.
- **Self-hosted and local-first:** Simple Docker deployment with no cloud dependency.

## How It Works

screensvr runs as a lightweight web application on the user's own server.

A central management interface allows users to install and configure screen faces. Each display opens a dedicated screensvr URL in its browser, which renders the selected face.

Changes made through the management interface can be reflected on connected displays automatically.

The platform is designed to work especially well with **Fully Kiosk Browser and Home Assistant**, while remaining compatible with ordinary web browsers.

## Development

Open the repository using **Dev Containers: Reopen in Container** in VS Code for
the Node.js, SQLite, linting, unit-testing, and cross-browser testing toolchain.
See [the development guide](docs/development.md) for requirements, rootless
Docker/Podman setup, and environment checks.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

Browser tests use Chromium, Firefox, and WebKit. Actual Fully Kiosk/Android
hardware still needs device testing.

## Vision

screensvr aims to do for idle screens what watch faces did for smartwatches: turn a functional display into something personal, beautiful, and expressive.

Instead of building another smart-home dashboard, screensvr focuses on the visual experience, combining elegant design, subtle animation, and useful information.

**One platform. Endless faces. Your screen, your style.**
