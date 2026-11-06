# Task Manager

Open **+ → Task Manager**. **Processes** combines live CPU, memory, and network charts with a searchable, sortable process table. **Performance** expands the charts and adds per-logical-CPU meters and per-interface network rates.

Chart history keeps up to 300 samples and can show the last one, two, or five minutes. Area/line style, graph visibility, update interval, row density, process-tree layout, and optional columns are available in **Task Manager options**. Choices persist locally. Pause freezes automatic sampling; Refresh requests one sample. Background/inactive panels stop polling. No telemetry history is stored on the server.

Click a column heading to sort and click again to reverse direction. Name/PID/command/UID search combines with state and user filters. Tree layout retains parent-child relationships inside the filtered set. Optional columns include user, state, threads, virtual memory, and nice value; PID/CPU/resident memory remain visible. Export downloads the current filtered/sorted table as CSV.

Double-click a process or choose **Details** for its command, working directory, executable, memory, thread count, priority, and I/O counters. **Terminal here** opens a terminal in its working directory; **Open executable** uses the existing file viewer. Access failures remain visible without erasing previous process data. No environment variables are read.

End task, Force kill, Pause, and Resume use the same authenticated machine API as the existing process controls. Delete/Backspace requests termination for the focused row. Destructive controls require confirmation and include the process start identity so a reused PID is not targeted.

CPU utilization is calculated from deltas in the first eight Linux CPU counters, excluding guest counters already included in user/nice. Per-process CPU is normalized to one logical CPU and may exceed 100%. The first sample displays Sampling. PID identity changes reset that process's CPU delta. Memory charts show resident system usage and swap; network charts show bytes per second computed from cumulative counters and elapsed client time. Counter resets produce zero rates. Permission-restricted `/proc` fields can be unavailable.

`client/task-manager.js` exports `createTaskManager({request, openFile, openTerminal, refreshInterval})`. The returned panel exposes lifecycle hooks and `api.refresh()`, `api.focusSearch()`, `api.setView(view)`, and `api.getState()`. `system.process` reads bounded command/status/I/O fields and checks process identity before and after the snapshot.

Run `tests/task-manager.cjs` for deterministic CPU/PID-reuse calculations, chart/customization controls, process inspector integration, signal identity, and mobile action bounds. Real `/proc` snapshots and signaling an owned disposable process remain covered by the server's tests.
