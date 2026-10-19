// Адреса компьютера в локальных сетях и VPN — по ним игроки (и телефон) подключаются к столу
import os from 'node:os';

/** Адреса в локальных сетях и VPN (Radmin VPN, ZeroTier, Hamachi, Tailscale…): сначала домашние сети */
export function lanAddresses() {
  const out = [];
  const skip = /vEthernet|VirtualBox|VMware|Hyper-V|docker|^br-|^veth|^virbr|Loopback|^lo$|WSL/i;
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (skip.test(name)) continue;
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' || a.address.startsWith('169.254.')) continue;
      out.push({ name, address: a.address });
    }
  }
  const rank = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a.address) - rank(b.address)).slice(0, 6);
}
