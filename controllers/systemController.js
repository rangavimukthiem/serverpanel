const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

function snapshotCpu() {
  const cpus = os.cpus();
  const total = cpus.reduce((sum, cpu) => {
    const values = Object.values(cpu.times);
    return sum + values.reduce((innerSum, value) => innerSum + value, 0);
  }, 0);
  const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0);

  return { idle, total };
}

async function getCpuUsage() {
  const start = snapshotCpu();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const end = snapshotCpu();
  const idle = end.idle - start.idle;
  const total = end.total - start.total;

  if (total <= 0) return 0;
  return Number((((total - idle) / total) * 100).toFixed(1));
}

async function getDiskUsage() {
  if (process.platform === 'win32') {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('df', ['-P', '/'], { timeout: 1500 });
    const lines = stdout.trim().split('\n');
    const parts = lines[1]?.split(/\s+/);
    const percent = parts?.[4]?.replace('%', '');
    return Number(percent);
  } catch (_error) {
    return null;
  }
}

async function status(_req, res, next) {
  try {
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const ram = Number((((totalMemory - freeMemory) / totalMemory) * 100).toFixed(1));
    const [cpu, disk] = await Promise.all([getCpuUsage(), getDiskUsage()]);

    return res.json({
      cpu,
      ram,
      uptime: Math.floor(os.uptime()),
      disk
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  status
};
