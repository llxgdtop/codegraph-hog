#!/usr/bin/env node
/**
 * graphhog — find out which agent window is hogging your CodeGraph daemon,
 * and free it with one click.
 *
 * Recognized agent hosts: Claude Desktop / Claude Code CLI / ZCode, plus a
 * generic fallback that labels any other host process.
 *
 * How it works:
 *
 *   Claude window process (--resume=<session-id>)
 *      └─ `codegraph serve --mcp` client (one per window)
 *           └─ unix socket → <project>/.codegraph/daemon.sock
 *                             └─ resident daemon (owns codegraph.db)
 *
 * graphhog matches unix-socket peer addresses to find every client PID that is
 * attached to a daemon, walks each client's process tree up to its agent
 * window process, and resolves the window name:
 *   - Claude windows prefer the desktop title stored under
 *     ~/Library/Application Support/Claude-3p/claude-code-sessions (files
 *     named local_*.json; on Windows: %APPDATA%\Claude-3p\...), falling back
 *     to the first user message in ~/.claude/projects/<project>/<session-id>.jsonl.
 *   - ZCode windows are identified by their working directory.
 *
 * Platform support:
 *   - macOS:  full fidelity (lsof peer matching, cwd, window titles)
 *   - Linux:  full process/window detection; connection state is inferred
 *             from established-socket + working-directory matching
 *             (/proc/net/unix has no peer info)
 *   - Windows: process/window detection via PowerShell WMI; no built-in
 *             AF_UNIX introspection, so clients are shown as "running"
 *
 * Zero dependencies. Requires Node.js >= 16.
 *
 * Usage:
 *   graphhog.mjs                          start the web dashboard (http://127.0.0.1:7742)
 *       --port N        port             --interval MS  scan interval (default 120000)
 *       --no-open       do not auto-open the browser
 *   graphhog.mjs list [--json]            print current occupancy
 *   graphhog.mjs watch                    refresh in the terminal
 *   graphhog.mjs kill <id>                drop one window's codegraph connection
 *   graphhog.mjs kill-window <id>         terminate the whole agent window process tree
 *   graphhog.mjs kill-daemon <pid>        stop a daemon (it restarts on next use)
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const HOME = os.homedir();
const PLATFORM = process.platform; // darwin | linux | win32
const SOCK_RE = /[/\\]\.codegraph[/\\]daemon\.sock$/;
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects');

// ---------- small helpers ----------

function sh(cmd, args, timeoutMs = 25000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ stdout: stdout || '', stderr: stderr || '', err });
      });
    } catch (e) {
      resolve({ stdout: '', stderr: String(e), err: e });
    }
  });
}

function tryStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

function fmtBytes(n) {
  if (n == null) return '-';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(2) + ' GB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB';
  return Math.round(n / 1024) + ' KB';
}

function fmtUptime(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm' + String(sec % 60).padStart(2, '0') + 's';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm';
  return Math.floor(sec / 86400) + 'd' + Math.floor((sec % 86400) / 3600) + 'h';
}

function etimeToSec(s) {
  if (!s) return 0;
  let sec = 0;
  const d = String(s).match(/^(\d+)-/);
  if (d) { sec += Number(d[1]) * 86400; s = s.slice(d[1].length + 1); }
  for (const p of s.split(':')) sec = sec * 60 + (Number(p) || 0);
  return sec;
}

// Base name of the executable part of a command line, portable across
// path separators and Windows ".exe" suffixes.
function baseName(cmd) {
  const exe = (cmd || '').trim().split(/\s+/)[0];
  return exe.split(/[\\/]/).pop().replace(/\.exe$/i, '');
}

function openBrowser(url) {
  if (PLATFORM === 'darwin') sh('open', [url]);
  else if (PLATFORM === 'win32') sh('cmd.exe', ['/c', 'start', '', url]);
  else sh('xdg-open', [url]);
}

// ---------- process snapshot (cross-platform) ----------

// macOS / Linux: one `ps` call. Elapsed time is used as the uptime source so
// no locale-dependent date parsing is needed.
async function psUnix() {
  const { stdout } = await sh('ps', ['-axo', 'pid=,ppid=,tty=,etime=,pcpu=,pmem=,rss=,command=']);
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 8 || !/^\d+$/.test(t[0])) continue;
    const uptimeSec = etimeToSec(t[3]);
    map.set(Number(t[0]), {
      pid: Number(t[0]),
      ppid: Number(t[1]),
      tty: t[2] === '??' || t[2] === '?' ? null : t[2],
      uptimeSec,
      startedAt: Date.now() - uptimeSec * 1000,
      cpu: Number(t[4]) || 0,
      memMB: Math.round((Number(t[6]) || 0) / 1024),
      cmd: t.slice(7).join(' '),
    });
  }
  return map;
}

// Windows: PowerShell WMI. No per-process tty; cpu% is not cheap to get here.
async function psWindows() {
  const cmd = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,WorkingSetSize,CommandLine | ConvertTo-Json -Compress';
  const { stdout } = await sh('powershell.exe', ['-NoProfile', '-Command', cmd], 40000);
  const map = new Map();
  let rows = [];
  try { rows = JSON.parse(stdout); } catch { return map; }
  if (!rows) return map;
  if (!Array.isArray(rows)) rows = [rows];
  for (const r of rows) {
    if (!r || r.ProcessId == null) continue;
    let startedAt = 0;
    const cd = String(r.CreationDate || '');
    const dm = cd.match(/\/Date\((\d+)\)\//);
    if (dm) startedAt = Number(dm[1]);
    else { const p = Date.parse(cd); if (p) startedAt = p; }
    map.set(Number(r.ProcessId), {
      pid: Number(r.ProcessId),
      ppid: Number(r.ParentProcessId) || 0,
      tty: null,
      startedAt,
      uptimeSec: startedAt ? (Date.now() - startedAt) / 1000 : 0,
      cpu: 0,
      memMB: Math.round((Number(r.WorkingSetSize) || 0) / 1024 / 1024),
      cmd: r.CommandLine || '',
    });
  }
  return map;
}

function psSnapshot() {
  return PLATFORM === 'win32' ? psWindows() : psUnix();
}

// ---------- unix socket discovery ----------
// Returns { daemonSocks: Map<pid, sockPath[]>, connByPid: Map<pid, daemonPid> }.
// connByPid may be empty on platforms where peer info is unavailable.

async function socketsDarwin() {
  const { stdout } = await sh('lsof', ['-U', '-w', '-n']);
  const rows = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(\d+)\s+\S+\s+(\d+)[a-z]?\s+unix\s+(0x[0-9a-f]+)\s+\S+\s+(\S*)\s*$/);
    if (m) rows.push({ pid: Number(m[2]), addr: m[4], name: m[5] });
  }
  const daemonSocks = new Map(); // pid -> [sockPath]
  const addrToDaemon = new Map();
  for (const r of rows) {
    if (r.name.startsWith('/') && SOCK_RE.test(r.name)) {
      if (!daemonSocks.has(r.pid)) daemonSocks.set(r.pid, []);
      const list = daemonSocks.get(r.pid);
      if (!list.includes(r.name)) list.push(r.name); // one entry per bound path (accepted conns repeat it)
    }
  }
  for (const [pid, paths] of daemonSocks) {
    for (const r of rows) {
      if (r.pid === pid && paths.includes(r.name)) addrToDaemon.set(r.addr, pid);
    }
  }
  const connByPid = new Map();
  for (const r of rows) {
    const m = r.name.match(/^->(0x[0-9a-f]+)$/);
    if (m && addrToDaemon.has(m[1])) connByPid.set(r.pid, addrToDaemon.get(m[1]));
  }
  return { daemonSocks, connByPid };
}

// Linux: /proc/net/unix has the socket table (kernel addr, state, inode, path)
// but no peer pairing, so connections are inferred later from established
// sockets + working directory. Here we only resolve daemon PIDs: find rows
// bound to a daemon.sock path, then locate the process holding that inode.
async function socketsLinux() {
  const daemonSocks = new Map();
  let lines = [];
  try { lines = fs.readFileSync('/proc/net/unix', 'utf8').split('\n'); } catch { return { daemonSocks, connByPid: new Map() }; }
  const wanted = new Map(); // inode -> path
  for (const line of lines.slice(1)) {
    const t = line.trim().split(/\s+/);
    // Num(0x...) RefCount Protocol Flags Type St Inode [Path]
    if (t.length < 7) continue;
    const p = t.slice(7).join(' ');
    if (p && SOCK_RE.test(p)) {
      const inode = Number(t[6]);
      if (inode) { wanted.set(inode, p); daemonSocks.set(-inode, [p]); } // placeholder keyed by -inode until pid is found
    }
  }
  // Resolve daemon pids by scanning /proc/<pid>/fd for socket:[inode].
  if (wanted.size) {
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { pids = []; }
    for (const pidStr of pids) {
      let fds = [];
      try { fds = fs.readdirSync(`/proc/${pidStr}/fd`); } catch { continue; }
      for (const fd of fds) {
        let link = '';
        try { link = fs.readlinkSync(`/proc/${pidStr}/fd/${fd}`); } catch { continue; }
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m && wanted.has(Number(m[1]))) {
          const pid = Number(pidStr);
          daemonSocks.set(pid, [wanted.get(Number(m[1]))]);
          daemonSocks.delete(-Number(m[1]));
          break;
        }
      }
    }
    for (const k of [...daemonSocks.keys()]) if (k < 0) daemonSocks.delete(k); // unresolved
  }
  return { daemonSocks, connByPid: new Map() };
}

// Windows: no built-in AF_UNIX introspection.
async function socketsWindows() {
  return { daemonSocks: new Map(), connByPid: new Map() };
}

function socketDiscovery() {
  if (PLATFORM === 'darwin') return socketsDarwin();
  if (PLATFORM === 'linux') return socketsLinux();
  return socketsWindows();
}

// Linux-only: does <pid> hold at least one ESTABLISHED, unnamed unix socket?
// Used to infer "connected" state (paired with cwd/project matching).
function linuxHasEstablishedUnix(pid) {
  let fds = [];
  try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { return false; }
  let unixInodes = [];
  for (const fd of fds) {
    let link = '';
    try { link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`); } catch { continue; }
    const m = link.match(/^socket:\[(\d+)\]$/);
    if (m) unixInodes.push(Number(m[1]));
  }
  if (!unixInodes.length) return false;
  let lines = [];
  try { lines = fs.readFileSync('/proc/net/unix', 'utf8').split('\n'); } catch { return false; }
  const set = new Set(unixInodes);
  for (const line of lines.slice(1)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 7) continue;
    const inode = Number(t[6]);
    const state = t[5];
    const hasPath = t.length > 7;
    if (set.has(inode) && !hasPath && state === '01') return true; // 01 = ESTABLISHED
  }
  return false;
}

// ---------- working directories ----------

async function cwdsDarwin(pids) {
  const { stdout } = await sh('lsof', ['-a', '-d', 'cwd', '-F', 'pn', '-w', '-p', pids.join(',')]);
  const map = new Map();
  let cur = null;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p') && /^\d+$/.test(line.slice(1))) cur = Number(line.slice(1));
    else if (line.startsWith('n/') && cur) { map.set(cur, line.slice(1)); cur = null; }
  }
  return map;
}

function cwdsLinux(pids) {
  const map = new Map();
  for (const pid of pids) {
    try { map.set(pid, fs.readlinkSync(`/proc/${pid}/cwd`)); } catch { /* gone or no permission */ }
  }
  return map;
}

function cwds(pids) {
  if (!pids.length) return Promise.resolve(new Map());
  if (PLATFORM === 'darwin') return cwdsDarwin(pids);
  if (PLATFORM === 'linux') return Promise.resolve(cwdsLinux(pids));
  return Promise.resolve(new Map());
}

// ---------- Claude desktop window titles ----------

// Claude Desktop stores per-window metadata (including the sidebar title) in
// claude-code-sessions/**/local_*.json. `cliSessionId` there is exactly the
// `--resume=` session id of the claude process, so we can join on it.
function claude3Roots() {
  const roots = [];
  const macRoot = path.join(HOME, 'Library', 'Application Support', 'Claude-3p');
  if (tryStat(macRoot)) roots.push(macRoot);
  if (process.env.APPDATA) {
    const winRoot = path.join(process.env.APPDATA, 'Claude-3p');
    if (tryStat(winRoot)) roots.push(winRoot);
  }
  return roots;
}

let desktopTitleCache = { ts: 0, map: new Map() };

function desktopTitles() {
  if (Date.now() - desktopTitleCache.ts < 15000) return desktopTitleCache.map;
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.startsWith('local_') && e.name.endsWith('.json')) {
        try {
          const o = JSON.parse(fs.readFileSync(p, 'utf8'));
          if (o.cliSessionId && typeof o.title === 'string' && o.title.trim()) {
            map.set(o.cliSessionId, o.title.trim());
          }
        } catch { /* skip broken file */ }
      }
    }
  };
  for (const root of claude3Roots()) walk(path.join(root, 'claude-code-sessions'));
  desktopTitleCache = { ts: Date.now(), map };
  return map;
}

// ---------- claude session title fallback (first user message) ----------

const titleCache = new Map(); // sessionId -> Promise<string|null>

// Skip system-injected messages; they make poor window titles.
const TITLE_SKIP_RE = /^(<|\[Request|Base directory|Caveat|Analysis|Skill |system-reminder|\[\/?command)/i;

function extractText(o) {
  let text = null;
  if (o.type === 'summary' && typeof o.summary === 'string') text = o.summary;
  else if (o.type === 'queue-operation' && typeof o.content === 'string') text = o.content;
  else if (o.type === 'user') {
    const c = o.message?.content ?? o.content;
    if (typeof c === 'string') text = c;
    else if (Array.isArray(c)) {
      const part = c.find((x) => x?.type === 'text' && typeof x.text === 'string');
      if (part) text = part.text;
    }
  }
  if (text?.trim()) {
    const t = text.trim();
    if (TITLE_SKIP_RE.test(t)) return null;
    return t.replace(/\s+/g, ' ').slice(0, 90);
  }
  return null;
}

function sessionTitle(sessionId) {
  if (!sessionId) return Promise.resolve(null);
  if (titleCache.has(sessionId)) return titleCache.get(sessionId);
  const p = (async () => {
    try {
      let dirs = [];
      try { dirs = fs.readdirSync(CLAUDE_PROJECTS).filter((d) => !d.startsWith('.')); } catch { return null; }
      for (const d of dirs) {
        const f = path.join(CLAUDE_PROJECTS, d, sessionId + '.jsonl');
        if (!tryStat(f)) continue;
        // Stream line by line, skip huge base64 resource lines, cap the search.
        const rl = readline.createInterface({ input: fs.createReadStream(f, { encoding: 'utf8' }), crlfDelay: Infinity });
        let read = 0, lines = 0;
        try {
          for await (const line of rl) {
            read += line.length; lines++;
            if (lines > 3000 || read > 4 * 1024 * 1024) break;
            if (line.length > 20000 || !line.startsWith('{')) continue;
            let o; try { o = JSON.parse(line); } catch { continue; }
            const t = extractText(o);
            if (t) return t;
          }
        } finally { rl.close(); }
      }
    } catch { /* ignore */ }
    return null;
  })();
  titleCache.set(sessionId, p);
  return p;
}

// ---------- agent / window identification ----------

function argOf(cmd, name) {
  let m = cmd.match(new RegExp('--' + name + '=(\\S+)'));
  if (m) return m[1];
  m = cmd.match(new RegExp('--' + name + '\\s+(\\S+)'));
  return m ? m[1] : null;
}

function isClaudeProc(p) {
  if (!p) return false;
  if (baseName(p.cmd) !== 'claude') {
    return /claude\.app\/Contents\/MacOS\/claude/.test(p.cmd) || /Claude-3p\/claude/.test(p.cmd);
  }
  return true;
}

function isZcodeProc(p) {
  if (!p) return false;
  const b = baseName(p.cmd);
  return /^zcode(-cli|-host-local)?$/.test(b) || /[\\/]ZCode\.app\//.test(p.cmd);
}

const SHELL_RE = /(^|[\\/])(zsh|bash|sh|dash|fish|tmux|screen|sshd|login)( |$)/;

/**
 * Walk up from a codegraph client root process to find the owning agent
 * window process. Returns { agentType, agentLabel, ownerPid, window, killable }.
 */
function findOwner(rootPid, ps) {
  const chain = [];
  let cur = ps.get(rootPid);
  for (let i = 0; i < 30 && cur; i++) {
    chain.push(cur);
    cur = ps.get(cur.ppid);
  }
  // The highest agent process in the chain is the window/session host.
  let owner = null;
  for (let i = chain.length - 1; i >= 0; i--) {
    const p = chain[i];
    if (isClaudeProc(p) && (p.cmd.includes('--resume=') || p.cmd.includes('--mcp-config'))) { owner = p; break; }
    if (isZcodeProc(p) && !/ZCode Helper|ZCode Computer Use/.test(p.cmd)) { owner = p; break; }
  }
  if (!owner) {
    const top = chain[chain.length - 1];
    return {
      agentType: 'other',
      agentLabel: top ? baseName(top.cmd) : '?',
      ownerPid: null, // orphan: never kill upwards (the top ancestor may be init/launchd)
      window: null,
      killable: false,
      topName: top ? baseName(top.cmd) : '?',
      topTty: top?.tty ?? null,
    };
  }
  if (isClaudeProc(owner)) {
    const ancestors = chain.slice(chain.indexOf(owner) + 1);
    const fromDesktop = ancestors.some((a) => /[\\/]Applications[\\/]Claude\.app[\\/]|Claude-3p|Helpers[\\/]disclaimer/.test(a.cmd));
    const fromShell = ancestors.some((a) => SHELL_RE.test(a.cmd)) || !!owner.tty;
    const sessionId = argOf(owner.cmd, 'resume');
    return {
      agentType: 'claude',
      agentLabel: fromDesktop ? 'Claude Desktop' : fromShell ? 'Claude Code CLI' : 'Claude',
      ownerPid: owner.pid,
      window: {
        sessionId,
        sessionShort: sessionId ? sessionId.slice(0, 8) : null,
        title: null, // filled asynchronously by scan()
        model: argOf(owner.cmd, 'model'),
        effort: argOf(owner.cmd, 'effort'),
      },
      killable: true,
    };
  }
  const isApp = /[\\/]Applications[\\/]ZCode\.app\//.test(owner.cmd) && baseName(owner.cmd) === 'ZCode';
  return {
    agentType: 'zcode',
    agentLabel: isApp ? 'ZCode (app main)' : 'ZCode',
    ownerPid: owner.pid,
    window: { sessionId: null, sessionShort: null, title: null, model: null, effort: null },
    killable: !isApp, // killing the whole Electron main process is too blunt to offer
  };
}

function descendants(pid, ps) {
  const out = [];
  const queue = [pid];
  while (queue.length) {
    const c = queue.shift();
    for (const p of ps.values()) {
      if (p.ppid === c && !out.includes(p.pid)) { out.push(p.pid); queue.push(p.pid); }
    }
  }
  return out;
}

// ---------- core scan ----------

const isCgProc = (p) =>
  /@colbymchenry\/codegraph[^ ]*node .*serve/.test(p.cmd) ||
  /[\\/]bin\/codegraph serve/.test(p.cmd) ||
  /codegraph(\.js)? serve/.test(p.cmd);

async function scan() {
  const t0 = Date.now();
  const [ps, socks] = await Promise.all([psSnapshot(), socketDiscovery()]);

  // 1. daemons: processes holding a bound .codegraph/daemon.sock socket.
  const daemons = [];
  const seenDaemon = new Set();
  for (const [pid, paths] of socks.daemonSocks) {
    for (const sockPath of paths) {
      const key = pid + '|' + sockPath;
      if (seenDaemon.has(key)) continue;
      seenDaemon.add(key);
      daemons.push({ pid, sockPath, project: path.resolve(sockPath, '..', '..') });
    }
  }
  // Windows fallback: no socket view, so identify the daemon by `--path`.
  if (PLATFORM === 'win32') {
    for (const p of ps.values()) {
      if (isCgProc(p) && /--path\s+\S+/.test(p.cmd)) {
        const proj = argOf(p.cmd, 'path');
        daemons.push({ pid: p.pid, sockPath: path.join(proj, '.codegraph', 'daemon.sock'), project: proj });
      }
    }
  }

  const clients = [];
  const ownerPids = [];
  const daemonPids = new Set(daemons.map((d) => d.pid));

  // 2. group codegraph client processes by root (parent that is not codegraph).
  for (const p of ps.values()) {
    if (!isCgProc(p) || daemonPids.has(p.pid)) continue;
    const parent = ps.get(p.ppid);
    if (parent && isCgProc(parent) && !daemonPids.has(parent.pid)) continue; // child of another codegraph proc
    const tree = [p.pid, ...descendants(p.pid, ps)];
    const sockHolder = tree.find((x) => socks.connByPid.has(x));
    const owner = findOwner(p.pid, ps);
    if (owner.ownerPid) ownerPids.push(owner.ownerPid);
    const holder = ps.get(sockHolder) ?? p;
    clients.push({
      id: sockHolder ?? p.pid, // stable id = socket holder pid (or root pid)
      rootPid: p.pid,
      treePids: tree,
      kind: sockHolder ? 'connected' : (PLATFORM === 'win32' && owner.agentType !== 'other') ? 'running' : owner.agentType !== 'other' ? 'idle' : 'orphan',
      daemonPid: sockHolder ? socks.connByPid.get(sockHolder) : null,
      clientPid: holder.pid,
      startedAt: holder.startedAt,
      uptimeSec: holder.uptimeSec,
      cpu: holder.cpu,
      memMB: holder.memMB,
      tty: holder.tty,
      cwd: null,
      ...owner,
    });
  }
  clients.sort((a, b) =>
    (b.kind === 'connected') - (a.kind === 'connected') || (b.ownerPid ?? 0) - (a.ownerPid ?? 0));

  // 3. working directories + window titles.
  const dTitles = desktopTitles();
  await Promise.all(clients.filter((c) => c.window?.sessionId).map(async (c) => {
    c.window.title = dTitles.get(c.window.sessionId) ?? (await sessionTitle(c.window.sessionId));
  }));
  const cwdMap = await cwds([...new Set([...ownerPids, ...clients.map((c) => c.rootPid), ...clients.map((c) => c.ownerPid).filter(Boolean)])]);
  for (const c of clients) c.cwd = cwdMap.get(c.ownerPid) ?? cwdMap.get(c.rootPid) ?? null;

  // 3b. Linux: infer connection state (established unix socket + project match).
  if (PLATFORM === 'linux') {
    for (const c of clients) {
      if (c.kind !== 'idle' || !c.cwd) continue;
      const hit = daemons.find((d) => {
        if (!path.isAbsolute(d.project)) return false;
        try { return path.resolve(c.cwd) === path.resolve(d.project); } catch { return false; }
      });
      if (hit && linuxHasEstablishedUnix(c.clientPid)) {
        c.kind = 'connected';
        c.daemonPid = hit.pid;
      }
    }
  }

  // ZCode windows have no session argument; use the working directory as identity.
  for (const c of clients) {
    if (c.agentType === 'zcode' && c.cwd && !c.window.title) c.window.title = path.basename(c.cwd);
  }

  // 4. daemon details.
  for (const d of daemons) {
    const p = ps.get(d.pid);
    const pm = p?.cmd?.match(/--path (\S+)/);
    if (pm) d.project = pm[1];
    d.projectShort = d.project.replace(HOME, '~');
    d.cpu = p?.cpu ?? 0;
    d.memMB = p?.memMB ?? 0;
    d.startedAt = p?.startedAt ?? 0;
    d.uptimeSec = p?.uptimeSec ?? 0;
    d.version = null;
    d.watchdog = null;
    d.lastLogs = [];
    d.clientCount = clients.filter((c) => c.daemonPid === d.pid).length;
    for (const q of ps.values()) {
      if (q.ppid === d.pid && /NO_WATCHDOG/.test(q.cmd)) d.watchdog = q.pid;
    }
    const dir = path.join(d.project, '.codegraph');
    d.dbSize = tryStat(path.join(dir, 'codegraph.db'))?.size ?? null;
    d.walSize = tryStat(path.join(dir, 'codegraph.db-wal'))?.size ?? null;
    try {
      const logPath = path.join(dir, 'daemon.log');
      const st = tryStat(logPath);
      if (st) {
        const fh = fs.openSync(logPath, 'r');
        const len = Math.min(8192, st.size);
        const buf = Buffer.alloc(len);
        fs.readSync(fh, buf, 0, len, st.size - len);
        fs.closeSync(fh);
        const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
        d.lastLogs = lines.slice(-10).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 220));
        for (let i = lines.length - 1; i >= 0; i--) {
          const vm = lines[i].match(/pid \d+, v([\d.]+)/);
          if (vm) { d.version = vm[1]; break; }
        }
      }
    } catch { /* ignore */ }
  }

  return { ts: Date.now(), scanMs: Date.now() - t0, platform: PLATFORM, daemons, clients };
}

// ---------- kill actions ----------

async function killTree(pids, graceMs = 2200) {
  const killed = [], escalated = [];
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); killed.push(pid); } catch { /* already gone */ }
  }
  await new Promise((r) => setTimeout(r, graceMs));
  for (const pid of pids) {
    try { process.kill(pid, 0); process.kill(pid, 'SIGKILL'); escalated.push(pid); } catch { /* gone */ }
  }
  return { killed, escalated };
}

async function doAction(action, id) {
  const st = await scan(); // re-scan first so a recycled pid can never be hit
  if (action === 'kill-daemon') {
    const d = st.daemons.find((x) => String(x.pid) === String(id));
    if (!d) return { ok: false, error: 'daemon pid=' + id + ' not found (it may have exited)' };
    const r = await killTree([d.pid], 3000);
    return { ok: true, message: 'daemon (pid ' + d.pid + ') stopped. It will restart automatically the next time any window uses codegraph.', detail: r };
  }
  const c = st.clients.find((x) => String(x.id) === String(id));
  if (!c) return { ok: false, error: 'connection id=' + id + ' not found (it may have dropped — refresh)' };
  if (action === 'kill') {
    const r = await killTree(c.treePids);
    return { ok: true, message: 'Disconnected ' + c.agentLabel + ' from codegraph (pids ' + c.treePids.join(', ') + ')', detail: r };
  }
  if (action === 'kill-window') {
    if (!c.ownerPid || !c.killable || c.ownerPid <= 1) {
      return { ok: false, error: 'This connection has no closable window process; use "Disconnect" instead' };
    }
    const ps = await psSnapshot();
    const pids = [...new Set([c.ownerPid, ...descendants(c.ownerPid, ps)])];
    const r = await killTree(pids, 2500);
    return { ok: true, message: 'Window closed: ' + c.agentLabel + ' pid ' + c.ownerPid + ' (' + pids.length + ' processes)', detail: r };
  }
  return { ok: false, error: 'unknown action: ' + action };
}

// ---------- CLI rendering ----------

const C = { dim: (s) => `\x1b[2m${s}\x1b[0m`, red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, cyan: (s) => `\x1b[36m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m` };
const kindTag = (k) => k === 'connected' ? C.green('● connected') : k === 'running' ? C.cyan('▶ running') : k === 'idle' ? C.yellow('○ not connected') : C.red('✖ orphan');

function renderText(st) {
  const L = [];
  L.push(C.bold('graphhog — CodeGraph occupancy monitor') + C.dim(`   ${new Date(st.ts).toLocaleString()}  ·  scan ${st.scanMs}ms  ·  ${st.platform}`));
  L.push('');
  if (!st.daemons.length) L.push(C.dim('  (no running codegraph daemon)'));
  for (const d of st.daemons) {
    L.push(`${C.cyan('▣ daemon')} pid ${C.bold(d.pid)}  v${d.version ?? '?'}  up ${fmtUptime(d.uptimeSec)}  cpu ${d.cpu}%  ${d.memMB}MB  clients ${d.clientCount}${d.watchdog ? C.dim(`  watchdog ${d.watchdog}`) : ''}`);
    L.push(`    ${d.projectShort}   DB ${fmtBytes(d.dbSize)}  WAL ${fmtBytes(d.walSize)}`);
  }
  L.push('');
  if (!st.clients.length) L.push(C.dim('  (no codegraph client processes)'));
  for (const c of st.clients) {
    let who;
    if (c.agentType === 'claude') {
      who = `${C.bold(c.agentLabel)} · window ${c.window.sessionShort ?? '?'} ${c.window.model ?? ''}`;
      if (c.window.title) who += `\n      "${c.window.title}"`;
    } else if (c.agentType === 'zcode') {
      who = `${C.bold(c.agentLabel)} · pid ${c.ownerPid}` + (c.window.title ? ` · cwd ${c.window.title}` : '');
    } else {
      who = C.red(`orphan (ancestor: ${c.topName ?? '?'}${c.topTty ? ' @' + c.topTty : ''})`);
    }
    L.push(`${kindTag(c.kind)}  id ${C.bold(c.id)}  ${who}`);
    L.push(`      client pid ${c.clientPid}  up ${fmtUptime(c.uptimeSec)}  cpu ${c.cpu}%  ${c.memMB}MB${c.cwd ? C.dim('  cwd ' + c.cwd.replace(HOME, '~')) : ''}`);
  }
  return L.join('\n');
}

// ---------- web dashboard ----------

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>graphhog — CodeGraph occupancy monitor</title>
<style>
:root{--bg:#0e1116;--card:#161b23;--line:#242c3a;--fg:#dde3ec;--dim:#8b95a5;--acc:#4f8cff;--ok:#3fb96f;--warn:#e0a93e;--bad:#e05c5c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:22px 26px}
h1{font-size:19px;margin:0 0 4px}.h1dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:9px;box-shadow:0 0 8px var(--ok)}
.sub{color:var(--dim);font-size:12.5px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:14px}
.card h2{margin:0 0 10px;font-size:15px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tag{font-size:11px;padding:2px 9px;border-radius:20px;border:1px solid var(--line);color:var(--dim);white-space:nowrap}
.tag.ok{color:var(--ok);border-color:rgba(63,185,111,.5)}.tag.bad{color:var(--bad);border-color:rgba(224,92,92,.5)}.tag.warn{color:var(--warn);border-color:rgba(224,169,62,.5)}
.kv{display:flex;flex-wrap:wrap;gap:6px 22px;color:var(--dim);font-size:12.5px}
.kv b{color:var(--fg);font-weight:600}
table{width:100%;border-collapse:collapse;font-size:13px}
th{color:var(--dim);text-align:left;font-weight:500;font-size:12px;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:9px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px}
.dim{color:var(--dim)}.t{color:var(--dim);font-size:12px;display:block;max-width:560px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{background:#202836;color:var(--fg);border:1px solid var(--line);border-radius:7px;padding:5px 11px;font-size:12px;cursor:pointer;margin-right:6px;white-space:nowrap}
button:hover{border-color:var(--acc)}button.danger{color:var(--bad)}button.danger:hover{border-color:var(--bad);background:rgba(224,92,92,.1)}
button:disabled{opacity:.45;cursor:default}
details{margin-top:8px}summary{cursor:pointer;color:var(--dim);font-size:12px}
pre{background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:11.5px;overflow:auto;max-height:220px;color:#9fb0c8;white-space:pre-wrap}
#toast{position:fixed;right:20px;bottom:20px;background:var(--card);border:1px solid var(--acc);border-radius:10px;padding:12px 16px;max-width:460px;font-size:13px;display:none;box-shadow:0 8px 30px rgba(0,0,0,.45);z-index:9}
.empty{color:var(--dim);padding:6px 0}
.win{max-width:560px}.win .sess{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:var(--acc)}
</style></head><body>
<h1><span class="h1dot"></span>graphhog — CodeGraph occupancy monitor <button style="float:right;font-size:12px" onclick="shutdownMonitor()">⏻ Stop monitor</button></h1>
<div class="sub" id="sub">Loading…</div>
<div id="app"></div>
<div id="toast"></div>
<script>
var S=null,busy={},INTERVAL=120000,USER='__USER__';
function $(s){return document.querySelector(s)}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
function fmtB(n){if(n==null)return '-';if(n>=1073741824)return (n/1073741824).toFixed(2)+' GB';if(n>=1048576)return (n/1048576).toFixed(1)+' MB';return Math.round(n/1024)+' KB'}
function fmtU(s){s=Math.round(s||0);if(s<60)return s+'s';if(s<3600)return Math.floor(s/60)+'m'+s%60+'s';if(s<86400)return Math.floor(s/3600)+'h'+Math.floor(s%3600/60)+'m';return Math.floor(s/86400)+'d'+Math.floor(s%86400/3600)+'h'}
function hhmm(t){return t?new Date(t).toLocaleTimeString():'-'}
function tilde(p){return p?String(p).replace('/Users/'+USER,'~').replace('/home/'+USER,'~'):p}
function toast(m,bad){var el=$('#toast');el.textContent=m;el.style.display='block';el.style.borderColor=bad?'var(--bad)':'var(--acc)';setTimeout(function(){el.style.display='none'},4600)}
function kill(action,id,desc){
  if(!confirm(desc))return;
  busy[action+'_'+id]=true;render();
  fetch('/api/kill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,id:id})})
    .then(function(r){return r.json()})
    .then(function(j){toast(j.message||j.error||'done',!j.ok)})
    .catch(function(e){toast('request failed: '+e.message,true)})
    .then(function(){delete busy[action+'_'+id];load()});
}
function shutdownMonitor(){
  if(!confirm('Stop the monitor service?\\nThe dashboard will go down; relaunch it anytime (start.command / start.sh / start.bat).'))return;
  fetch('/api/shutdown',{method:'POST'}).then(function(){
    document.title='graphhog (stopped)';
    document.body.innerHTML='<div class="card"><div class="empty">Monitor stopped. Relaunch with start.command (macOS) / start.sh (Linux) / start.bat (Windows).</div></div>';
  }).catch(function(){
    document.body.innerHTML='<div class="card"><div class="empty">Monitor stopped. Relaunch with start.command (start.sh on Linux, start.bat on Windows).</div></div>';
  });
}
function load(){fetch('/api/state').then(function(r){return r.json()}).then(function(d){S=d;render()}).catch(function(e){$('#sub').textContent='connection failed: '+e.message})}
function render(){
  var st=S;if(!st)return;
  var conn=st.clients.filter(function(c){return c.kind==='connected'||c.kind==='running'}).length;
  $('#sub').textContent='updated '+new Date(st.ts).toLocaleTimeString()+' · scan '+st.scanMs+'ms · '+conn+' window(s) attached · auto refresh every '+Math.round(INTERVAL/1000)+'s';
  var h=[];
  if(!st.daemons.length)h.push('<div class="card"><div class="empty">No running codegraph daemon</div></div>');
  for(var i=0;i<st.daemons.length;i++){var d=st.daemons[i];
    h.push('<div class="card"><h2><span style="color:var(--acc)">▣</span>daemon pid '+d.pid+
      '<span class="tag">v'+esc(d.version||'?')+'</span>'+
      '<span class="tag '+(d.clientCount?'ok':'warn')+'">'+d.clientCount+' window(s)</span>'+
      (d.watchdog?'<span class="tag">watchdog '+d.watchdog+'</span>':'')+
      '<span style="flex:1"></span><button class="danger" onclick="kill(\\'kill-daemon\\','+d.pid+',\\'Stop daemon (pid '+d.pid+') ?\\\\nProject: '+esc(d.projectShort)+'\\\\nIt will restart automatically the next time any window uses codegraph.\\')">Stop daemon</button></h2>'+
      '<div class="kv"><span>project <b class="mono">'+esc(d.projectShort)+'</b></span><span>up <b>'+fmtU(d.uptimeSec)+'</b></span><span>started <b>'+hhmm(d.startedAt)+'</b></span><span>cpu <b>'+d.cpu+'%</b></span><span>mem <b>'+d.memMB+'MB</b></span><span>DB <b>'+fmtB(d.dbSize)+'</b></span><span>WAL <b>'+fmtB(d.walSize)+'</b></span></div>'+
      (d.lastLogs&&d.lastLogs.length?'<details><summary>daemon log (recent)</summary><pre>'+esc(d.lastLogs.join('\\n'))+'</pre></details>':'')+
      '</div>');
  }
  h.push('<div class="card"><h2>Windows / clients holding codegraph</h2>');
  if(!st.clients.length)h.push('<div class="empty">No codegraph client processes</div>');
  else{
    h.push('<table><tr><th>Status</th><th>Agent / window</th><th>Client process</th><th>Uptime</th><th style="text-align:right">Actions</th></tr>');
    for(var j=0;j<st.clients.length;j++){var c=st.clients[j];
      var kt=c.kind==='connected'?'<span class="tag ok">● connected</span>':c.kind==='running'?'<span class="tag">▶ running</span>':c.kind==='idle'?'<span class="tag warn">○ not connected</span>':'<span class="tag bad">✖ orphan</span>';
      var who;
      if(c.agentType==='claude'){
        who='<b>'+esc(c.agentLabel)+'</b> <span class="sess">'+esc(c.window.sessionShort||'?')+'</span>'+
            (c.window.model?' <span class="dim">'+esc(c.window.model)+(c.window.effort?' · '+esc(c.window.effort):'')+'</span>':'')+
            (c.window.title?'<span class="t" title="'+esc(c.window.title)+'">\\u201C'+esc(c.window.title)+'\\u201D</span>':'');
      }else if(c.agentType==='zcode'){
        who='<b>'+esc(c.agentLabel)+'</b> <span class="dim mono">pid '+c.ownerPid+'</span>'+
            (c.window.title?'<span class="t">cwd: '+esc(c.window.title)+'</span>':'');
      }else{
        who='<span class="dim">orphan — ancestor: '+esc(c.topName||'?')+(c.topTty?' @'+esc(c.topTty):'')+'</span>';
      }
      if(c.cwd)who+='<span class="t mono">cwd: '+esc(tilde(c.cwd))+'</span>';
      var b1=busy['kill_'+c.id]?'disabled':'',b2=busy['kill-window_'+c.id]?'disabled':'';
      h.push('<tr><td>'+kt+'</td><td class="win">'+who+'</td>'+
        '<td class="mono">pid '+c.clientPid+'<br><span class="dim">cpu '+c.cpu+'% · '+c.memMB+'MB</span></td>'+
        '<td>'+fmtU(c.uptimeSec)+'<br><span class="dim">'+hhmm(c.startedAt)+'</span></td>'+
        '<td style="text-align:right;white-space:nowrap"><button '+b1+' onclick="kill(\\'kill\\','+c.id+',\\'Disconnect this window from codegraph (client pid '+c.clientPid+') ?\\\\nThe window itself is not affected.\\')">Disconnect</button>'+
        (c.ownerPid&&c.killable?'<button class="danger" '+b2+' onclick="kill(\\'kill-window\\','+c.id+',\\'Close the whole window?\\\\nThis terminates '+esc(c.agentLabel)+' pid '+c.ownerPid+' and all its child processes.\\')">Close window</button>':'')+
        '</td></tr>');
    }
    h.push('</table>');
  }
  h.push('</div>');
  $('#app').innerHTML=h.join('');
}
fetch('/api/config').then(function(r){return r.json()}).then(function(c){INTERVAL=c.interval}).catch(function(){}).then(function(){load();setInterval(load,INTERVAL)});
</script></body></html>`;

// ---------- web server ----------

async function startServer(port, interval, open) {
  let latest = await scan();
  let scanning = false;
  const loop = setInterval(async () => {
    if (scanning) return;
    scanning = true;
    try { latest = await scan(); } catch (e) { console.error('scan failed:', e.message); }
    scanning = false;
  }, interval);

  const server = http.createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    const send = (code, type, body) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
    if (pathname === '/') return send(200, 'text/html; charset=utf-8', HTML.replace('__USER__', os.userInfo().username || 'user'));
    if (pathname === '/api/state') return send(200, 'application/json; charset=utf-8', JSON.stringify(latest));
    if (pathname === '/api/config') return send(200, 'application/json; charset=utf-8', JSON.stringify({ interval }));
    if (pathname === '/api/kill' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { action, id } = JSON.parse(body);
        const r = await doAction(action, id);
        if (r.ok) { try { latest = await scan(); } catch {} }
        return send(200, 'application/json; charset=utf-8', JSON.stringify(r));
      } catch (e) {
        return send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, error: e.message }));
      }
    }
    if (pathname === '/api/shutdown' && req.method === 'POST') {
      send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true }));
      setTimeout(() => { clearInterval(loop); server.close(); process.exit(0); }, 300);
      return;
    }
    return send(404, 'text/plain', 'not found');
  });

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.log(C.yellow('Port ' + port + ' is already in use — the dashboard is already running. Opening the browser.'));
      if (open) openBrowser('http://127.0.0.1:' + port);
      clearInterval(loop);
      process.exit(0);
    }
    console.error(e);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + port;
    console.log(C.green('✔ graphhog dashboard: ') + C.cyan(url));
    console.log(C.dim('  Ctrl+C to stop · CLI: graphhog.mjs list | kill <id> | kill-window <id> | kill-daemon <pid>'));
    if (open) openBrowser(url);
  });

  const stop = () => { clearInterval(loop); server.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('SIGHUP', stop); // closing the Terminal window that launched us
}

// ---------- entry point ----------

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] && !args[0].startsWith('--') ? args[0] : 'web';
  const flag = (name, def) => {
    const i = args.indexOf('--' + name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  switch (cmd) {
    case 'list': {
      const st = await scan();
      if (args.includes('--json')) {
        const clean = JSON.parse(JSON.stringify(st));
        for (const c of clean.clients) delete c.treePids;
        console.log(JSON.stringify(clean, null, 2));
      } else console.log(renderText(st));
      break;
    }
    case 'watch':
      while (true) {
        const st = await scan();
        process.stdout.write('\x1b[2J\x1b[H' + renderText(st) + '\n');
        await new Promise((r) => setTimeout(r, Number(flag('interval', '3000'))));
      }
    case 'kill':
    case 'kill-window':
    case 'kill-daemon': {
      const id = args[1];
      if (!id) { console.error('usage: graphhog.mjs ' + cmd + ' <id|pid>'); process.exit(1); }
      const r = await doAction(cmd, id);
      console.log(r.ok ? C.green('✔ ' + r.message) : C.red('✖ ' + r.error));
      process.exit(r.ok ? 0 : 1);
    }
    case 'web':
    case 'serve':
      await startServer(Number(flag('port', '7742')), Number(flag('interval', '120000')), !args.includes('--no-open'));
      break;
    default:
      console.error('unknown command: ' + cmd + ' · available: list | watch | kill | kill-window | kill-daemon | web');
      process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
