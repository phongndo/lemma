import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** This machine's addresses and private networks' (an IPv4 address written as IPv6 counts as itself). */
const LOCAL = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
] as const)
  LOCAL.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
] as const)
  LOCAL.addSubnet(address, prefix, "ipv6");

const isLocalAddress = (address: string): boolean => {
  const family = isIP(address);
  return family !== 0 && LOCAL.check(address, family === 4 ? "ipv4" : "ipv6");
};

/**
 * Whether `url` reaches this machine or a private network: `localhost` or a name under it, such an address, or a name
 * that resolves to one. Only web addresses (`http`, `https`, `ws`, `wss`) do; a name that does not resolve does not
 * (its request fails anyway).
 */
export async function isLocalUrl(url: string): Promise<boolean> {
  let host: string;
  try {
    const parsed = new URL(url);
    if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return false;
    host = parsed.hostname.replace(/^\[(.*)\]$/, "$1").replace(/\.$/, "");
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (isIP(host) !== 0) return isLocalAddress(host);
  const addresses = await lookup(host, { all: true }).catch(() => []);
  return addresses.some(({ address }) => isLocalAddress(address));
}
