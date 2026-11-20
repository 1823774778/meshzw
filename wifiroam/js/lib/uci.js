// uci.js -- UCI read/write wrapper, `uci` CLI end to end.
// Target: Node 22.23.4, core modules only, zero npm dependencies.
//
// The original daemon used the ucode `uci` module (cursor.get/set/add/
// delete/foreach/commit/load). This module keeps the same call shapes
// and value semantics, but every operation goes through the `uci`
// command-line tool -- never by reading /etc/config files directly.
// One tool, one code path.
//
// Mapping (ucode cursor -> CLI):
//   get(pkg, section)            -> parse of `uci show <pkg>`; null if absent
//   get(pkg, section, option)    -> string | string[] (list option) | null
//   set(pkg, section, type)      -> `uci set <pkg>.<section>=<type>` (create named section)
//   set(pkg, section, opt, val)  -> `uci set <pkg>.<section>.<opt>=<val>`
//                                    (string value; string[] value is
//                                    delete + one `uci add_list` per element,
//                                    matching cursor.set(pkg, s, o, [..]))
//   add(pkg, type[, name])       -> `uci add <pkg> <type> [name]`; stdout is the new sid
//   delete(pkg, section[, opt])  -> `uci delete <pkg>.<section>[.<opt>]`
//   commit(pkg)                  -> `uci commit <pkg>`
//   foreach(pkg, type, cb)       -> parse of `uci show <pkg>`; cb(section)
//                                    where section has `.name` (sid) and
//                                    `.type`, plus its options
//   load(pkg)                    -> no-op returning true: the CLI reads
//                                    fresh state on every call, so there
//                                    is nothing to cache or reload.
//
// Failure semantics (matching the original's silent style): get returns
// null (or [] for getList), foreach visits nothing, and set/add/delete/
// commit return false when the `uci` command fails. Nothing here throws
// for a missing package/section/option or a failing command; only
// programming errors (missing required arguments) throw TypeError.
// Values are passed as argv, never through a shell.
//
// One known divergence from the ucode cursor, documented here rather
// than papered over: the CLI requires a section to exist before
// `uci set <pkg>.<section>.<opt>=...` succeeds, so set() returns false
// for a missing section and the caller must add() it first. (In the
// original code every set() target either exists in the default config
// or was just created by add()/the 3-argument set() form.)

import { execFileSync } from 'node:child_process';

// Default runner: (argv) => { code, stdout }. Spawn errors yield code 1.
function defaultRunner(argv) {
  try {
    const out = execFileSync('uci', argv, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout: typeof out === 'string' ? out : '' };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout ? String(e.stdout) : '',
    };
  }
}

// Parse `uci show <pkg>` output into { sections: [{ '.name', '.type', ...opts }] }.
//   wifiroam.core=globals
//   wifiroam.core.enabled='1'
//   wifiroam.cfg0a1b2c3=appdev
//   wifiroam.cfg0a1b2c3.block='wechat' 'douyin'
// A list option may also appear as repeated lines with the same key;
// repeated occurrences accumulate into an array.
export function parseShow(output) {
  const sections = [];
  const byName = new Map();
  if (typeof output !== 'string' || output === '') return sections;
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const rawVal = line.slice(eq + 1);
    const parts = key.split('.');
    if (parts.length < 2) continue;
    const sid = parts[1];
    let sec = byName.get(sid);
    if (!sec) {
      sec = { '.name': sid, '.type': null };
      byName.set(sid, sec);
      sections.push(sec);
    }
    if (parts.length === 2) {
      // Section header: type is unquoted (e.g. `=globals`).
      sec['.type'] = rawVal.replace(/^'|'$/g, '');
      continue;
    }
    const opt = parts.slice(2).join('.');
    // Value: zero or more single-quoted tokens, or a bare token.
    const tokens = [];
    const quoted = rawVal.match(/'((?:[^']|'')*)'/g);
    if (quoted) {
      for (const q of quoted) tokens.push(q.slice(1, -1).replace(/''/g, "'"));
    } else if (rawVal !== '') {
      tokens.push(rawVal);
    }
    const value = tokens.length === 1 ? tokens[0] : tokens;
    if (Object.prototype.hasOwnProperty.call(sec, opt)) {
      const prev = sec[opt];
      sec[opt] = Array.isArray(prev) ? prev.concat(tokens) : [prev].concat(tokens);
    } else {
      sec[opt] = value;
    }
  }
  return sections;
}

export class UciClient {
  // opts.runner: (argv: string[]) => { code: number, stdout: string }
  // Defaults to running the real `uci` binary.
  constructor(opts = {}) {
    this.runner = typeof opts.runner === 'function' ? opts.runner : defaultRunner;
  }

  _run(argv) {
    try {
      const r = this.runner(argv);
      return { code: typeof r?.code === 'number' ? r.code : 1, stdout: typeof r?.stdout === 'string' ? r.stdout : '' };
    } catch (_e) {
      return { code: 1, stdout: '' };
    }
  }

  _show(pkg) {
    const r = this._run(['show', pkg]);
    if (r.code !== 0) return [];
    return parseShow(r.stdout);
  }

  // No-op for call-site parity with ucode cursor.load(): the CLI reads
  // fresh state on every call. Always returns true.
  load(_pkg) {
    return true;
  }

  // get(pkg, section) -> section object { '.name', '.type', ... } | null
  // get(pkg, section, option) -> string | string[] | null
  get(pkg, section, option) {
    if (!pkg || !section) throw new TypeError('uci.get: pkg and section are required');
    const sec = this._show(pkg).find((s) => s['.name'] === section);
    if (!sec) return null;
    if (option === undefined) return sec;
    const v = sec[option];
    return v === undefined ? null : v;
  }

  // getList(pkg, section, option) -> string[] (empty when missing/not a list).
  // Mirrors the original's as_list(get(...)) pattern.
  getList(pkg, section, option) {
    const v = this.get(pkg, section, option);
    if (Array.isArray(v)) return v;
    if (typeof v === 'string' && v !== '') return [v];
    return [];
  }

  // set(pkg, section, type) -> create a named section of that type.
  // set(pkg, section, option, value) -> set an option; value may be a
  // string or a string[] (list option: delete + add_list per element;
  // an empty array just deletes the option).
  // Returns true on success, false when the command fails (e.g. the
  // section does not exist yet -- add() it first).
  set(pkg, section, option, value) {
    if (!pkg || !section || !option) throw new TypeError('uci.set: pkg, section and option/type are required');
    if (value === undefined) {
      return this._run(['set', `${pkg}.${section}=${option}`]).code === 0;
    }
    if (Array.isArray(value)) {
      this._run(['delete', `${pkg}.${section}.${option}`]);
      let ok = true;
      for (const el of value) {
        if (this._run(['add_list', `${pkg}.${section}.${option}=${el}`]).code !== 0) ok = false;
      }
      return ok;
    }
    return this._run(['set', `${pkg}.${section}.${option}=${String(value)}`]).code === 0;
  }

  // add(pkg, type[, name]) -> new section id (e.g. "cfg0a1b2c3"), or null.
  add(pkg, type, name) {
    if (!pkg || !type) throw new TypeError('uci.add: pkg and type are required');
    const argv = name === undefined ? ['add', pkg, type] : ['add', pkg, type, name];
    const r = this._run(argv);
    if (r.code !== 0) return null;
    const sid = r.stdout.trim();
    return sid === '' ? null : sid;
  }

  // delete(pkg, section[, option]) -> true on success, false otherwise.
  delete(pkg, section, option) {
    if (!pkg || !section) throw new TypeError('uci.delete: pkg and section are required');
    const target = option === undefined ? `${pkg}.${section}` : `${pkg}.${section}.${option}`;
    return this._run(['delete', target]).code === 0;
  }

  // commit(pkg) -> true on success, false otherwise.
  commit(pkg) {
    if (!pkg) throw new TypeError('uci.commit: pkg is required');
    return this._run(['commit', pkg]).code === 0;
  }

  // foreach(pkg, type, cb) -> number of sections visited.
  // cb receives the section object ({ '.name', '.type', ...options }).
  // A missing package or a failed `uci show` visits nothing.
  foreach(pkg, type, cb) {
    if (!pkg || !type) throw new TypeError('uci.foreach: pkg and type are required');
    if (typeof cb !== 'function') throw new TypeError('uci.foreach: cb must be a function');
    let n = 0;
    for (const sec of this._show(pkg)) {
      if (sec['.type'] !== type) continue;
      n++;
      cb(sec);
    }
    return n;
  }
}

// Default singleton bound to the real `uci` binary. Business modules
// import { uci } and call uci.get/set/... directly.
export const uci = new UciClient();

export function createUciClient(opts = {}) {
  return new UciClient(opts);
}
