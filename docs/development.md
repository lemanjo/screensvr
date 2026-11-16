# Development environment

The repository includes a Dev Container for the complete development toolchain.
Dependencies are installed on container creation, but the application is not
started automatically.

## Application workflow

```sh
npm ci
npm run dev
```

Open `http://localhost:5173` for development. The Vite server proxies API and face
requests to Fastify on port 3000. Local state is stored in the ignored `data/`
directory. To use a different directory, export `SCREENSVR_DATA_DIR`.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
```

Build before browser tests: they exercise the production application, with a
temporary database and real Chromium, Firefox, and WebKit browsers. Outside the
Dev Container, install browsers with
`npx playwright install --with-deps chromium firefox webkit`.

`npm start` runs the production build on port 3000. Node's built-in SQLite driver
avoids native package compilation. Project-local tools and dependencies are
pinned in `package-lock.json`; `npm ci` is the reproducible install path.
The `minimatch` override patches a transitive lint-tool vulnerability. The only
approved dependency install script is the pinned esbuild postinstall; review
and update its approval deliberately when changing that dependency.

## Requirements

- A running Docker-compatible container engine.
- VS Code with the **Dev Containers** extension, or another Dev Container client.
- An internet connection for the initial image, packages, and browser downloads.

Open this repository in VS Code and run **Dev Containers: Reopen in Container**.
The first build downloads three browser engines and can take several minutes.
Development runs as the non-root `node` user, with 1 GiB of shared memory for
browser tests.

### Rootless Docker and Podman

The default host socket is `/var/run/docker.sock`. If your engine uses another
socket, set `SCREENSVR_DOCKER_SOCKET` on the host **before launching your editor**.
For example, with rootless Podman:

```sh
systemctl --user start podman.socket
export SCREENSVR_DOCKER_SOCKET="$XDG_RUNTIME_DIR/podman/podman.sock"
code .
```

When using Podman as the Dev Container engine, also set VS Code's
`dev.containers.dockerPath` user setting to `podman`. Rootless Docker users should
set `SCREENSVR_DOCKER_SOCKET` to their Docker socket instead. Restart an already
running editor if it has not picked up the environment variable.

The container reuses the host engine rather than running a privileged nested
daemon. **Host socket access grants control over that engine and its resources**;
only open trusted code in this container. The Docker feature disables SELinux
container labeling to allow the shared socket on SELinux hosts.

## Included tools

| Area                     | Tools                                                                         |
| ------------------------ | ----------------------------------------------------------------------------- |
| JavaScript               | Node.js 24 LTS, npm, TypeScript, tsx                                          |
| Frontend                 | Vite                                                                          |
| Quality                  | ESLint, Prettier, ShellCheck                                                  |
| Unit/integration tests   | Vitest, V8 coverage, Vitest UI                                                |
| Browser/end-to-end tests | Playwright, Chromium, Firefox, WebKit, browser OS libraries, Xvfb             |
| Database                 | SQLite CLI, SQLite development headers                                        |
| Native modules           | Python 3, GCC/G++, Make, pkg-config                                           |
| Containers               | Docker CLI, Compose, Buildx, host engine socket                               |
| Utilities                | Git, GitHub CLI, curl, jq, ripgrep, OpenSSL, zip/unzip, network/process tools |
| AI coding                | OpenCode CLI (V2)                                                             |
| Editor                   | ESLint, Prettier, Vitest, Playwright, SQLite viewer extensions                |

Bootstrap JavaScript tools are pinned in `.devcontainer/tooling/package.json` and
its npm lockfile, and installed at `/opt/screensvr-tooling`. The image and Dev
Container feature versions are also pinned, with feature digests recorded in
`.devcontainer/devcontainer-lock.json`. The base Node image receives updates when
its version is deliberately bumped.

React, Fastify, and application tools are declared in the root `package.json`.
Bootstrap tools do not replace project dependencies. Use npm scripts so
project-local versions take precedence. Test files cannot import packages from
the isolated bootstrap installation.

On container creation, setup runs `npm ci` if a root `package.json` and
`package-lock.json` exist. A missing lockfile is reported rather than generating
one implicitly. Setup then verifies the tools, SQLite read/write operations, and actual
headless canvas rendering in all three browsers.

Run those checks again at any time:

```sh
bash .devcontainer/scripts/check-environment.sh
docker info
```

`docker info` separately checks access to the host engine; the environment checks
only require its CLI plugins and do not start or modify host containers.

## GitHub CLI and OpenCode

Both `gh` and `opencode` are available in container terminals and checked during
setup. OpenCode is installed from the official `@opencode/cli` npm package, with
its version pinned alongside the other bootstrap tools.

Authenticate interactively when needed:

```sh
gh auth login
opencode
```

Inside OpenCode, use `/connect` to sign in to a model provider. This configuration
does not mount host credentials or persist sign-in state across container
rebuilds. Never put tokens in the Dockerfile or commit them to the repository.

## Ports

The container forwards these ports to localhost when used by a development tool:

| Port  | Intended service        |
| ----- | ----------------------- |
| 3000  | Fastify API             |
| 5173  | Vite development server |
| 4173  | Vite preview            |
| 51204 | Vitest UI               |
| 9323  | Playwright HTML report  |
| 9229  | Node.js debugger        |

Once application scripts exist, bind web servers to `0.0.0.0` inside the container
(for example, `vite --host 0.0.0.0`). Keep forwarded ports private; in particular,
do not expose the Node debugger to your network.

## Browser testing

Headless browser tests work without a desktop session. Playwright's browser
binaries are installed in `/ms-playwright`, shared through
`PLAYWRIGHT_BROWSERS_PATH`. Setup also installs the browser revisions required by
project-local Playwright when present. After changing the project's Playwright
version, rerun `.devcontainer/scripts/post-create.sh` with Bash.

For headed tests without a display server, use `xvfb-run -a` before the test
command. Interactive Playwright UI windows require a separate desktop/display
setup; no VNC service or desktop is exposed by default.

The environment supports SSE and Home Assistant REST/WebSocket development with
ordinary Node.js and browser APIs. It does not start Home Assistant or copy any
credentials from the host.

## Docker commands inside the container

Builds and Compose commands use the host engine. Bind-mount source paths are
therefore resolved on the **host**, not inside the devcontainer. For example:

```sh
docker run --rm \
  --mount "type=bind,source=$LOCAL_WORKSPACE_FOLDER,target=/workspace,readonly" \
  alpine ls /workspace
```

Use named volumes or host paths for Compose mounts, and never remove unrelated
host containers or volumes as part of project cleanup.

## Updating the environment

After changing the Dockerfile, features, or bootstrap tools, run
**Dev Containers: Rebuild Container**. To update a bootstrap package, update its
exact version and regenerate the lockfile using Node.js 24:

```sh
npm install --package-lock-only --ignore-scripts --prefix .devcontainer/tooling
```

Do not commit `node_modules`, browser binaries, local databases, credentials, or
test reports.
