import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const environment = path.join(root, ".env");
if (!existsSync(environment)) {
  const contents = readFileSync(path.join(root, ".env.example"), "utf8")
    .replace(
      "REPLACE_WITH_LOCAL_ADMIN_PASSWORD",
      randomBytes(18).toString("base64url"),
    )
    .replace("REPLACE_WITH_64_HEX_CHARACTERS", randomBytes(32).toString("hex"));
  writeFileSync(environment, contents, { mode: 0o600 });
  console.log("Created .env with private local credentials.");
}
const docker = spawnSync("docker", ["--version"], { encoding: "utf8" });
if (docker.status !== 0)
  throw new Error(
    "Docker or Podman is required for the local PostgreSQL container.",
  );
const env = { ...process.env };
if (/podman/i.test(docker.stdout)) {
  env.DOCKER_HOST ||= `unix://${process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`}/podman/podman.sock`;
  if (!existsSync(env.DOCKER_HOST.replace("unix://", ""))) {
    const socket = spawnSync(
      "systemctl",
      ["--user", "start", "podman.socket"],
      { stdio: "inherit" },
    );
    if (socket.status !== 0)
      throw new Error("Start the user Podman socket before running setup.");
  }
}
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`Setup command failed: ${command}`);
}
run("docker", ["compose", "-p", "bilcode-monitoring-local", "up", "-d"]);
run("npm", ["run", "db:generate"]);
run("npm", ["run", "db:migrate"]);
console.log("Backend ready. Run npm run dev; API: http://127.0.0.1:4100/api.");
console.log(
  "Admin credentials are in .env; monitoring starts stopped. Run the frontend from its own repository.",
);
