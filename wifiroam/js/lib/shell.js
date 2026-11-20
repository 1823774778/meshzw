// shell.js -- external command execution.
// Target: Node 22.23.4, core modules only, zero npm dependencies.
//
// Two execution paths, matching the original exactly:
//   * cmdOutput(cmd) -- synchronous, via /bin/sh -c, the equivalent of
//     ucode cmd_output(): fs.popen(cmd, "r") + read("all"). Only stdout
//     is returned; the exit code is NOT read (fs.popen provides none),
//     stderr is discarded, and any spawn failure yields "".
//     Commands are run verbatim, including their own "2>/dev/null"
//     redirections; arguments are spliced into the string exactly as
//     the original sprintf() did (spec §9.23: no escaping is added).
//   * runProcess(path, args) -- asynchronous, argv-based, no shell, the
//     equivalent of uloop.process(path, [args], null, cb): resolves with
//     the exit code (the `res` the original callbacks log), or null when
//     the process could not be started, was killed by a signal, or the
//     timeout fired.
//
// shellCommands holds the §7.3 command literals so business modules do
// not retype them (and cannot silently drift from the original wording).

import { execFileSync, spawn } from 'node:child_process';

// Default synchronous runner: (cmd, { timeout }) => stdout string.
// `timeout` is in milliseconds; 0 means no timeout (execFileSync
// default). Any error -- spawn failure, timeout, non-zero exit --
// yields "" (exit codes are never surfaced by cmdOutput).
function defaultCommandRunner(cmd, { timeout = 0 } = {}) {
  try {
    const out = execFileSync('/bin/sh', ['-c', cmd], {
      encoding: 'utf8',
      timeout: timeout > 0 ? timeout : undefined,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return typeof out === 'string' ? out : '';
  } catch (_e) {
    return '';
  }
}

let commandRunner = defaultCommandRunner;

// Test hook only: replace the synchronous runner (e.g. with a fake that
// records commands and returns canned output). Business code must not use it.
export function setCommandRunner(fn) {
  commandRunner = typeof fn === 'function' ? fn : defaultCommandRunner;
}

export function resetCommandRunner() {
  commandRunner = defaultCommandRunner;
}

// Synchronous: run `cmd` through /bin/sh -c, return all of stdout,
// "" on any failure. The exit code is deliberately not returned.
export function cmdOutput(cmd, opts = {}) {
  if (typeof cmd !== 'string' || cmd === '') return '';
  try {
    const out = commandRunner(cmd, opts);
    return typeof out === 'string' ? out : '';
  } catch (_e) {
    return '';
  }
}

// Asynchronous, shell form: run `cmd` through /bin/sh -c, collect
// stdout/stderr, resolve { code, stdout, stderr }. `code` is the exit
// code, or null when the process was killed by a signal, timed out,
// or could not be started.
export function runShellAsync(cmd, { timeout = 0 } = {}) {
  return new Promise((resolve) => {
    if (typeof cmd !== 'string' || cmd === '') {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }
    let child;
    try {
      child = spawn('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_e) {
      resolve({ code: null, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timer = null;
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    if (timeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
    }
    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', () => done(null));
    child.on('close', (code, signal) => done(signal ? null : code));
  });
}

// Asynchronous, argv form (uloop.process equivalent): spawn `path` with
// `args` (no shell), stdio ignored, resolve with the exit code, or null
// when the process could not be started, was killed by a signal, or the
// timeout fired. opts.onExit(code), when given, is called with the same
// value (the original callback received `res`).
export function runProcess(path, args = [], { timeout = 0, onExit } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(path, args, { stdio: 'ignore' });
    } catch (_e) {
      if (typeof onExit === 'function') onExit(null);
      resolve(null);
      return;
    }
    let timer = null;
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (typeof onExit === 'function') {
        try { onExit(code); } catch (_e) { /* callback errors are ignored */ }
      }
      resolve(code);
    };
    if (timeout > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        done(null);
      }, timeout);
      if (typeof timer.unref === 'function') timer.unref();
    }
    child.on('error', () => done(null));
    child.on('close', (code, signal) => done(signal ? null : code));
  });
}

// ------------------------------------------------------- §7.3 literals
// Every function returns the exact command string the original passed
// to cmd_output() (sprintf %s slots filled in order). Trailing
// redirections are part of the literal. The async service reloads of
// §7.4 are argv lists in PROC (used with runProcess, no shell).
export const shellCommands = Object.freeze({
  // appctl nft (APPCTL_TABLE = "wifiroam")
  nftFlushChain: (table, chain) => `nft flush chain inet ${table} ${chain} 2>/dev/null`,
  nftDeleteSet: (table, set) => `nft delete set inet ${table} ${set} 2>/dev/null`,
  nftAddTable: (table) => `nft add table inet ${table} 2>/dev/null`,
  nftDeleteTable: (table) => `nft delete table inet ${table} 2>/dev/null`,
  nftApplyFile: (file) => `nft -f ${file} 2>/dev/null`,
  nftListTableJson: (table) => `nft -j list table inet ${table} 2>/dev/null`,
  nftListFlowtables: () => 'nft list flowtables 2>/dev/null',
  nftFlushFlowtable: (family, table, name) => `nft flush flowtable ${family} ${table} ${name} 2>/dev/null`,
  nftListChainForward: () => 'nft list chain inet fw4 forward 2>/dev/null',
  // services (sync forms; the async argv forms live in PROC below)
  firewallReload: () => '/etc/init.d/firewall reload >/dev/null 2>&1',
  dnsmasqRestart: () => '/etc/init.d/dnsmasq restart >/dev/null 2>&1',
  guestFirewallReload: () => '/etc/init.d/firewall reload 2>/dev/null',
  // DPI
  dpiPid: () => 'pidof wifiroam-dpi 2>/dev/null',
  dpiPidCheck: (pid) => `kill -0 ${pid} 2>/dev/null && echo 1`,
  dpiKill: (pid) => `kill ${pid} 2>/dev/null`,
  dpiKillHup: (pid) => `kill -HUP ${pid} 2>/dev/null`,
  dpiStart: () => '/usr/sbin/wifiroam-dpi & echo $! > /tmp/wifiroam-dpi.pid',
  // DNS warm-up (one hostname per tick)
  nslookupWarm: (host) => `timeout 3 nslookup ${host} 127.0.0.1 >/dev/null 2>&1`,
  // wireless / uplink
  iwDevLink: (ifname) => `iw dev ${ifname} link 2>/dev/null`,
  ipRouteDefault: () => 'ip route show default 2>/dev/null',
  wifiReloadDelayed: () => '( sleep 2; /sbin/wifi reload >/dev/null 2>&1 ) >/dev/null 2>&1 & echo ok',
  // clock
  dateHm: () => 'date +%H:%M',
  // guest
  iwDev: () => 'iw dev 2>/dev/null',
  ipNeighDev: (dev) => `ip neigh show dev ${dev} 2>/dev/null`,
  tcQdiscDel: (dev) => `tc qdisc del dev ${dev} root 2>/dev/null`,
  tcQdiscShow: (dev) => `tc qdisc show dev ${dev} 2>/dev/null`,
  tcQdiscAddHtb: (dev) => `tc qdisc add dev ${dev} root handle 1: htb default 20 2>/dev/null`,
  tcClassAdd: (dev, classid, rateKbit) =>
    `tc class add dev ${dev} parent 1: classid ${classid} htb rate ${rateKbit}kbit ceil ${rateKbit}kbit 2>/dev/null`,
  tcFilterAdd: (dev, ip, flowid) =>
    `tc filter add dev ${dev} parent 1: protocol ip prio 1 u32 match ip dst ${ip}/32 flowid ${flowid} 2>/dev/null`,
  // clients
  bridgePortNames: (brdev) => `brctl showstp ${brdev} 2>/dev/null`,
  bridgeFdbShow: (brdev) => `bridge fdb show br ${brdev} 2>/dev/null`,
  brctlShowmacs: (brdev) => `brctl showmacs ${brdev} 2>/dev/null`,
  iwStationDump: (ifname) => `iw dev ${ifname} station dump 2>/dev/null`,
  // precheck: wpad package probe (apk first, opkg fallback)
  wpadApk: () => `apk list --installed 2>/dev/null | awk '{print $1}' | grep -E '^wpad' | head -1`,
  wpadOpkg: () => `opkg list-installed 2>/dev/null | grep -E '^wpad' | head -1`,
});

// §7.4 async processes (uloop.process call sites), as [path, args] pairs.
export const PROC = Object.freeze({
  dnsmasqReload: Object.freeze(['/etc/init.d/dnsmasq', Object.freeze(['reload'])]),
  firewallReload: Object.freeze(['/etc/init.d/firewall', Object.freeze(['reload'])]),
  networkReload: Object.freeze(['/etc/init.d/network', Object.freeze(['reload'])]),
  wifiReload: Object.freeze(['/sbin/wifi', Object.freeze(['reload'])]),
});
