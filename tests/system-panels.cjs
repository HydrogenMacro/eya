const { spawnSync } = require('node:child_process');
const path = require('node:path');
for (const suite of ['task-manager.cjs', 'docker-advanced.cjs']) {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit', env: process.env, timeout: 180000 });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
