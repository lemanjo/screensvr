# Development

This guide is for working on screensvr itself. To run it as a service, use
[Deployment](deployment.md). To build only a face, use [Building a face](faces.md).

Choose **Node.js 24 LTS locally** or the included **Dev Container**. Both use the
same project scripts; the Dev Container also supplies browsers, system libraries,
container tools, and other utilities.

## Run locally

With Git and Node.js 24 installed:

```sh
git clone https://github.com/lemanjo/screensvr.git
cd screensvr
npm ci
npm run dev
```

Open **http://localhost:5173**. Vite forwards API and face requests to Fastify on
port 3000. Both servers bind to `0.0.0.0` for container access; keep development
ports private and do not use this server in production.

State is stored in the ignored `data/` directory. Export `SCREENSVR_DATA_DIR`
to use another directory; do not point development at production data.
Environment files are not loaded automatically. See
[environment variables](deployment.md#environment-variables).

## Run checks

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

| Command             | Purpose                                                               |
| ------------------- | --------------------------------------------------------------------- |
| `npm run typecheck` | Check server, shared, frontend, and test TypeScript.                  |
| `npm run lint`      | Run ESLint.                                                           |
| `npm test`          | Run Vitest unit and integration tests.                                |
| `npm run build`     | Compile the server and build the production frontend.                 |
| `npm run test:e2e`  | Test the production app with Chromium, Firefox, and WebKit.           |
| `npm run format`    | Format the configured source and documentation paths; rewrites files. |

Build before browser tests. Outside the Dev Container, first install the
project's browsers and their OS dependencies:

```sh
npx playwright install --with-deps chromium firefox webkit
```

Browser tests use temporary data rather than your development database.
`npm start` runs the production build on port 3000.

### Integration and device testing

Automated tests use local fake Home Assistant, Immich, and iCalendar servers,
temporary photo fixtures, and mocked Wikimedia/NASA responses. They need no
personal credentials, photo library, NAS, live smart-home services, or access to
public image APIs.

Before a release, also verify representative real services and target hardware:

- Home Assistant sensors, weather/forecast capabilities, and calendar providers.
- Immich on the supported 3.4.1+ 3.x range, including album permissions and previews.
- Real iCalendar subscription feeds, recurrence, privacy, and timezones.
- Mounted photo permissions and missing-source recovery.
- Wikimedia/NASA album filtering, resized-image delivery, credits, and
  temporary provider failures.
- Fully Kiosk/Android sleep/resume, idle activation, and long-running rendering.
- Scene schedules, DST boundaries, and reconnection after a missed transition.

Desktop browser checks do not replace tablet/WebView testing. See
[integration requirements](integrations.md) and the
[face testing checklist](faces.md#design-and-testing-checklist).

## Use the Dev Container

Requires a Docker-compatible engine, a Dev Container client such as VS Code
with **Dev Containers**, and internet access for the initial downloads.

Open the repository and run **Dev Containers: Reopen in Container**.
The first build can take several minutes while tools and browser engines download.
Dependencies are installed on creation; the application is **not** started
automatically. Run `npm run dev` when ready.

The container runs as the non-root `node` user and allocates 1 GiB of shared
memory for browser tests.

### Rootless Docker and Podman

The default host engine socket is `/var/run/docker.sock`. For another socket,
set `SCREENSVR_DOCKER_SOCKET` on the host **before starting your editor**.
For rootless Podman:

```sh
systemctl --user start podman.socket
export SCREENSVR_DOCKER_SOCKET="$XDG_RUNTIME_DIR/podman/podman.sock"
code .
```

For Podman as the Dev Container engine, also set VS Code's
`dev.containers.dockerPath` user setting to `podman`. Rootless Docker users
should supply their Docker socket instead. Restart an editor that has not picked
up the environment variable.

The container reuses the host engine, not a privileged nested daemon.
**Socket access grants control of that engine and its resources.** Open only
trusted code. The Docker feature disables SELinux container labeling for socket
access on SELinux hosts.

### Included tools

| Area                       | Tools                                                                 |
| -------------------------- | --------------------------------------------------------------------- |
| Runtime and frontend       | Node.js 24 LTS, npm, TypeScript, tsx, Vite                            |
| Quality and tests          | ESLint, Prettier, ShellCheck, Vitest/V8 coverage/UI, Playwright       |
| Browsers                   | Chromium, Firefox, WebKit, OS libraries, Xvfb                         |
| Database and native builds | SQLite CLI/headers, Python 3, GCC/G++, Make, pkg-config               |
| Containers                 | Docker CLI, Compose, Buildx, host engine socket                       |
| Utilities                  | Git, GitHub CLI, curl, jq, ripgrep, OpenSSL, zip/unzip, network tools |
| AI coding                  | OpenCode CLI                                                          |
| Editor extensions          | ESLint, Prettier, Vitest, Playwright, SQLite viewer                   |

Bootstrap JavaScript tools are pinned in
[`.devcontainer/tooling/package.json`](../.devcontainer/tooling/package.json)
and its lockfile, then installed at `/opt/screensvr-tooling`. Image/feature versions
are pinned too, with feature digests in `.devcontainer/devcontainer-lock.json`.

Application dependencies belong in the root `package.json`. Bootstrap packages
do not replace them; use npm scripts so project-local tools take precedence.
Tests must not import packages from the isolated bootstrap installation.

### Check the environment

Creation runs `npm ci` when the project manifest and lockfile exist. A missing
lockfile is reported, not generated. Setup checks tools, SQLite read/write, and
real headless canvas rendering in all three browsers.

To repeat the checks:

```sh
bash .devcontainer/scripts/check-environment.sh
docker info
```

`docker info` separately checks host-engine access. Environment checks only
require its CLI plugins; they do not start or modify host containers.

GitHub CLI and OpenCode are available in the container. Authenticate
interactively when needed; host credentials are not mounted, and sign-in state
is not persisted across rebuilds. Never put tokens in a Dockerfile or commit them.

### Ports and browser tools

The Dev Container forwards these tool ports to localhost:

| Port  | Intended service        |
| ----- | ----------------------- |
| 3000  | Fastify application/API |
| 5173  | Vite development server |
| 4173  | Vite preview            |
| 51204 | Vitest UI               |
| 9323  | Playwright HTML report  |
| 9229  | Node.js debugger        |

Only started tools listen on these ports. Keep them private, especially the debugger.

Headless tests need no desktop session. Browser binaries are installed under
`/ms-playwright` through `PLAYWRIGHT_BROWSERS_PATH`. Setup also installs revisions
required by project-local Playwright. After changing that dependency, rerun
`bash .devcontainer/scripts/post-create.sh`.

For headed tests without a display server, prefix the command with `xvfb-run -a`.
Interactive UI windows need a separate desktop/display setup; no VNC or desktop
service is exposed by default.

### Docker commands inside the container

Builds and Compose use the host engine. Bind-mount source paths are resolved
on the **host**, not inside the Dev Container:

```sh
docker run --rm \
  --mount "type=bind,source=$LOCAL_WORKSPACE_FOLDER,target=/workspace,readonly" \
  alpine ls /workspace
```

Use named volumes or valid host paths. Never remove unrelated host containers
or volumes as part of project cleanup.

## Dependencies and environment updates

Use `npm ci` with the committed lockfile for reproducible installs. Node's
built-in SQLite driver avoids a separate native database addon. Photo processing
uses pinned `sharp` and its platform-specific libvips binaries; keep optional
npm dependencies enabled.

To try photos, export `SCREENSVR_PHOTOS_DIR` to a test directory. The application
does not start Home Assistant or copy host credentials.

The `minimatch` override addresses a transitive lint-tool vulnerability. Only the
pinned esbuild postinstall is approved as a dependency install script. Review
that approval deliberately when updating it. See the [security policy](../SECURITY.md)
for the separate, time-limited development-tool advisory acceptance.

After Dockerfile, feature, or bootstrap-tool changes, run **Dev Containers:
Rebuild Container**. To change a bootstrap package, update its exact version
and regenerate the lockfile with Node.js 24:

```sh
npm install --package-lock-only --ignore-scripts --prefix .devcontainer/tooling
```

Do not commit `node_modules`, browser binaries, local databases, credentials, or
test reports. For system boundaries and publishing, see
[Architecture](architecture.md) and [Releasing](releasing.md).
