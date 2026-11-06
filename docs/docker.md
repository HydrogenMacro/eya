# Docker workspace

Open **+ → Docker**. The panel follows the workspace theme and can be split, resized, tabbed, or opened more than once.

## Containers and resource graphs

Containers show state, CPU, memory, image, and published ports. Search matches names, IDs, images, states, and Compose labels. Filter running, paused, or stopped containers, and sort by name, state, CPU, or memory. CPU can exceed 100% for workloads using multiple cores.

CPU and memory charts show aggregate usage when no container is selected. Open a container to show that container's own history, keyed by its Docker ID. Histories are bounded to 120 samples per container and 200 container IDs per panel; changing a selection never joins one container's samples to another. Data starts accumulating when the panel opens and is not a historical monitoring database. Docker stats failures produce unavailable values rather than invented zero samples.

Container details provide Overview, Logs, Processes, and raw Inspect. Overview includes health, restart count, launch command, network and disk I/O, mounts, networks, and labels. Available actions include Start/Stop, Restart, Pause/Resume, and **Open terminal**, which opens an independent Eya terminal running `docker exec -it … /bin/sh`. Images without `/bin/sh` need a different shell command typed in a terminal.

## Compose and the editor

Compose lists projects and services, with Start, Up, Stop, and Restart controls. **Open compose.yml** (or the actual configuration filename) opens a configuration file in the existing Eya file editor. Projects with several configuration files expose each path. Container details also link back to their Compose configuration and expose bind-mount source paths through Eya's file viewers/browser support. The paths come from Docker's project metadata; stale/missing files report the normal file error.

Compose **Up** uses the project's existing configuration with `--detach`. Controls do not remove projects, containers, images, volumes, or networks. Stop, Restart, Pause, and Up require confirmation. Images, Networks, and Volumes views provide searchable inventories and raw Inspect details.

## Logs

Logs support client-side text filtering, 100–5000 recent lines, timestamps, a time range, manual refresh, optional live polling, and downloading the fetched text. Requests are snapshots rather than an unbounded streaming subprocess. With timestamps enabled, stdout/stderr lines are merged by their Docker timestamps. Without timestamps, separate stdout/stderr captures cannot preserve inter-stream chronology. Log output is bounded by the server's machine-command output limits; reduce the requested line count if those limits are exceeded.

## Customization and lifecycle

**Docker view options** controls refresh interval (3/5/10/30 seconds), table density, area/line charts, graph visibility, and image/port columns. Preferences persist in browser storage; histories remain local to the panel. Clear graph history removes collected samples. The **Live** toggle pauses polling; hidden/inactive panels and open action menus pause automatic requests. Search and log filter inputs retain normal text-editing behavior.

All operations travel through the authenticated encrypted connection. The server needs the Docker CLI, Compose plugin, and access to its Docker daemon/context. Native mode uses the server user; host mode uses the configured host namespaces and login identity. See [system-panels.md](system-panels.md) for permissions, command deadlines, and output bounds.

`createDockerPanel({request,openFile,openTerminal,refreshInterval})` returns panel lifecycle hooks and API methods `refresh`, `focusSearch`, `setView`, `openContainer`, and `getState`. `openFile(path)` and `openTerminal(command)` connect Docker operations to existing workbench facilities. `tests/docker-advanced.cjs` checks these integrations, graphs, filtering, resources, customization, and phone-sized action controls using deterministic data. `EYA_TEST_DOCKER=1 cargo test system::tests::docker_read_only_integration` also checks real read-only container/Compose/resource inventories.
