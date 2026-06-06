import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ports = [4747, 5173, 8787];

const pids = new Set();

for (const port of ports) {
  for (const pid of await pidsForPort(port)) {
    if (pid !== process.pid) {
      pids.add(pid);
    }
  }
}

for (const pid of pids) {
  await killProcess(pid);
  console.log(`Stopped stale process ${pid}`);
}

async function pidsForPort(port) {
  if (process.platform === "win32") {
    const { stdout } = await execFileAsync("netstat", ["-ano"]);
    return stdout
      .split(/\r?\n/)
      .filter((line) => line.includes(`:${port}`) && /LISTENING|UDP/i.test(line))
      .map((line) => Number(line.trim().split(/\s+/).at(-1)))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }

  try {
    const { stdout } = await execFileAsync("lsof", ["-ti", `:${port}`]);
    return stdout
      .split(/\s+/)
      .map((value) => Number(value))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    return [];
  }
}

async function killProcess(pid) {
  if (process.platform === "win32") {
    await execFileAsync("taskkill", ["/PID", String(pid), "/F"]);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}
