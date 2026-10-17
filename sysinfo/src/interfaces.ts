import { readFile, readdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";

const states = ["up", "down", "unknown", "dormant", "lowerlayerdown", "notpresent", "testing"] as const;
export interface NetworkInterface {
  name: string;
  kind?: "loopback" | "tun" | "other" | "unknown";
  state: typeof states[number];
  addresses: Array<{ address: string; family: "IPv4" | "IPv6"; cidr: string | null }>;
}

export async function readInterfaces(
  sysfsRoot = "/sys/class/net",
  addresses = networkInterfaces(),
): Promise<NetworkInterface[]> {
  const entries = await readdir(sysfsRoot, { withFileTypes: true });
  // sysfs can also contain control files such as bonding_masters.
  const names = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name).sort();
  return Promise.all(names.map(async (name) => {
    const raw = await readFile(join(sysfsRoot, name, "operstate"), "utf8").catch(() => "unknown");
    const state = states.find((value) => value === raw.trim()) ?? "unknown";
    const [type, tunFlags] = await Promise.all([
      readFile(join(sysfsRoot, name, "type"), "utf8").catch(() => ""),
      readFile(join(sysfsRoot, name, "tun_flags"), "utf8").catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : undefined),
    ]);
    const kind: NetworkInterface["kind"] = type.trim() === "772" ? "loopback"
      : typeof tunFlags === "string" && /^0x[\da-f]+$/i.test(tunFlags.trim()) ? "tun"
      : type.trim() && tunFlags === null ? "other" : "unknown";
    return {
      name,
      kind,
      state,
      addresses: (addresses[name] ?? []).map(({ address, family, cidr }) => ({ address, family, cidr })),
    };
  }));
}
