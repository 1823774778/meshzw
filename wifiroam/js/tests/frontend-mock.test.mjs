// Frontend mock harness for the wifiroam LuCI rewrite (base 0.261115.15302).
//
// No jsdom: a hand-written, lightweight DOM + LuCI-global mock. It loads the
// rewritten modules from ../luci-app-wifiroam, drives each page's load() ->
// render() path with fake ubus data (shaped like the real daemon replies),
// and asserts the key paths do not throw and produce the expected structure.
// Fake timers are manual: window.setTimeout only fires when flushTimers()
// is called, so polling loops never run away in the test process.
//
// Run: node --test tests/frontend-mock.test.mjs (from ~/workspace/wifiroam-js)
//   or: npm test   (runs every tests/*.test.mjs file)

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 仓库里前端在 wifiroam/ 旁边，静态资源在 htdocs/ 下（交付包的 www/ 布局）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'luci-app-wifiroam');
const staticPath = (rel) => path.join(ROOT, rel.replace(/^www\//, 'htdocs/'));
const NOW = Math.floor(Date.now() / 1000);
const TODAY = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Minimal DOM
// ---------------------------------------------------------------------------
class TextNode {
    constructor(text) {
        this.nodeType = 3;
        this.textContent = String(text);
        this.parentNode = null;
        this.children = [];
    }
}

class El {
    constructor(tag, ns = null) {
        this.tagName = String(tag).toUpperCase();
        this.nodeType = 1;
        this.namespaceURI = ns;
        this.children = [];
        this.parentNode = null;
        this._attrs = new Map();
        this._classSet = new Set();
        this._listeners = {};
        this.dataset = {};
        this.style = {};
        this._value = '';
        this.checked = false;
        this.disabled = false;
        this.offsetWidth = 0;
        this._classList = {
            add: (...cs) => cs.forEach((c) => c && this._classSet.add(c)),
            remove: (...cs) => cs.forEach((c) => this._classSet.delete(c)),
            toggle: (c, force) => {
                const on = force === undefined ? !this._classSet.has(c) : !!force;
                if (on) this._classSet.add(c);
                else this._classSet.delete(c);
                return on;
            },
            contains: (c) => this._classSet.has(c),
        };
    }

    get classList() {
        return this._classList;
    }
    get className() {
        return [...this._classSet].join(' ');
    }
    set className(v) {
        this._classSet = new Set(String(v || '').split(/\s+/).filter(Boolean));
    }
    get textContent() {
        return this.children.map((c) => c.textContent ?? '').join('');
    }
    set textContent(v) {
        for (const c of this.children) c.parentNode = null;
        this.children = [];
        if (v !== null && v !== undefined && v !== '') this.appendChild(new TextNode(String(v)));
    }
    get innerHTML() {
        return this.textContent;
    }
    set innerHTML(v) {
        this.textContent = v;
    }
    get options() {
        return this.children.filter((c) => c.nodeType === 1 && c.tagName === 'OPTION');
    }
    get value() {
        return this._value;
    }
    set value(v) {
        this._value = v === null || v === undefined ? '' : String(v);
    }

    appendChild(child) {
        if (child === null || child === undefined || child === false) return child;
        if (typeof child === 'string' || typeof child === 'number') child = new TextNode(String(child));
        if (child.parentNode) child.parentNode.removeChild(child);
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    removeChild(child) {
        const i = this.children.indexOf(child);
        if (i >= 0) {
            this.children.splice(i, 1);
            child.parentNode = null;
        }
        return child;
    }
    addEventListener(type, fn) {
        (this._listeners[type] ||= []).push(fn);
    }
    removeEventListener(type, fn) {
        const l = this._listeners[type];
        if (l) {
            const i = l.indexOf(fn);
            if (i >= 0) l.splice(i, 1);
        }
    }
    dispatch(type, ev = {}) {
        const e = { target: this, currentTarget: this, stopPropagation() {}, preventDefault() {}, ...ev };
        for (const fn of this._listeners[type] || []) fn.call(this, e);
        return e;
    }
    setAttribute(k, v) {
        this._attrs.set(k, String(v));
        if (k === 'class') this.className = v;
    }
    getAttribute(k) {
        if (k === 'class') return this.className || null;
        return this._attrs.has(k) ? this._attrs.get(k) : null;
    }
    removeAttribute(k) {
        this._attrs.delete(k);
    }
    hasAttribute(k) {
        return this._attrs.has(k);
    }
    contains(node) {
        let n = node;
        while (n) {
            if (n === this) return true;
            n = n.parentNode;
        }
        return false;
    }
    querySelectorAll(sel) {
        const out = [];
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const walk = (el) => {
            for (const c of el.children) {
                if (c.nodeType !== 1) continue;
                if (parts.some((p) => matchSel(c, p))) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    querySelector(sel) {
        return this.querySelectorAll(sel)[0] || null;
    }
}

function matchSel(el, sel) {
    if (sel.startsWith('.')) return el.classList.contains(sel.slice(1));
    if (sel.startsWith('#')) return el.getAttribute('id') === sel.slice(1);
    if (sel.includes('[')) {
        const m = sel.match(/^([a-z0-9]*)?\[([^\]=]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]$/i);
        if (m) {
            if (m[1] && el.tagName !== m[1].toUpperCase()) return false;
            const v = el.getAttribute(m[2]);
            if (v === null) return false;
            const want = m[3] ?? m[4];
            return want === undefined || v === want;
        }
    }
    return el.tagName === sel.toUpperCase();
}

function findInTree(root, pred) {
    if (root.nodeType === 1 && pred(root)) return root;
    for (const c of root.children || []) {
        const r = findInTree(c, pred);
        if (r) return r;
    }
    return null;
}

// E() — LuCI element builder.
function E(tag, attrs, children) {
    const el = new El(tag);
    if (attrs) {
        for (const [k, v] of Object.entries(attrs)) {
            if (v === null || v === undefined) continue;
            if (k === 'class') el.className = v;
            else if (k === 'click' || k === 'change' || k === 'input' || k === 'keydown' || k === 'keyup')
                el.addEventListener(k, v);
            else if (k === 'style' && typeof v === 'string') {
                el.style.cssText = v;
                for (const part of v.split(';')) {
                    const [pk, pv] = part.split(':');
                    if (pk && pv !== undefined) {
                        const key = pk.trim();
                        el.style[key] = pv.trim();
                        el.style[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = pv.trim();
                    }
                }
            } else if (k === 'value') el.value = v;
            else if (k === 'checked') el.checked = !!v;
            else if (k === 'disabled') el.disabled = v === 'disabled' || !!v;
            else if (k === 'textContent') el.textContent = v;
            else if (k.startsWith('data-')) {
                el.setAttribute(k, v);
                el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
            } else el.setAttribute(k, v);
        }
    }
    const add = (c) => {
        if (c === null || c === undefined || c === false) return;
        if (Array.isArray(c)) c.forEach(add);
        else el.appendChild(c);
    };
    add(children);
    return el;
}

const documentElement = new El('html');
const body = new El('body');
documentElement.appendChild(body);

const document = {
    documentElement,
    body,
    activeElement: null,
    createElement: (tag) => new El(tag),
    createElementNS: (ns, tag) => new El(tag, ns),
    createTextNode: (text) => new TextNode(text),
    getElementById: (id) => findInTree(documentElement, (el) => el.getAttribute('id') === id),
    querySelector: (sel) => findInTree(documentElement, (el) => matchSel(el, sel)),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
};

// Fake timers: only fire when flushTimers() is called.
const timers = [];
let timerSeq = 0;
const window = {
    setTimeout(cb, ms, ...args) {
        const id = ++timerSeq;
        timers.push({ id, cb, ms: ms || 0, args, done: false, cancelled: false });
        return id;
    },
    clearTimeout(id) {
        const t = timers.find((x) => x.id === id);
        if (t) t.cancelled = true;
    },
    matchMedia() {
        return { matches: false, addEventListener() {}, addListener() {}, removeEventListener() {} };
    },
    localStorage: {
        _m: new Map(),
        getItem(k) {
            return this._m.has(k) ? this._m.get(k) : null;
        },
        setItem(k, v) {
            this._m.set(k, String(v));
        },
        removeItem(k) {
            this._m.delete(k);
        },
    },
    confirm(msg) {
        confirmCalls.push(msg);
        return true;
    },
    location: {
        reload() {
            reloadCalls.push(true);
        },
    },
};
const confirmCalls = [];
const reloadCalls = [];

function flushTimers(maxDelay = 0, maxRounds = 100) {
    let rounds = 0;
    while (rounds++ < maxRounds) {
        const t = timers.find((x) => !x.done && !x.cancelled && x.ms <= maxDelay);
        if (!t) break;
        t.done = true;
        t.cb(...t.args);
    }
}

async function settle(rounds = 12) {
    for (let i = 0; i < rounds; i++) {
        flushTimers(0);
        await new Promise((r) => setImmediate(r));
    }
    flushTimers(0);
}

class MutationObserver {
    constructor() {}
    observe() {}
    disconnect() {}
}

// LuCI String.format: '%d/%s ...'.format(...)
if (!String.prototype.format) {
    String.prototype.format = function (...args) {
        let i = 0;
        return this.replace(/%%|%[dsf]/g, (m) => (m === '%%' ? '%' : String(args[i++] ?? '')));
    };
}

const _ = (s) => s;
const L = {
    bind: (fn, ctx) => fn.bind(ctx),
    resource: (p) => '/luci-static/resources/' + p,
    url: (...parts) => '/cgi-bin/luci/' + parts.join('/'),
};

const modalStack = [];
const ui = {
    showModal(title, content) {
        const m = E('div', { class: 'modal' }, [
            E('div', { class: 'modal-title' }, title),
            ...(Array.isArray(content) ? content : [content]),
        ]);
        document.body.appendChild(m);
        modalStack.push(m);
        return m;
    },
    hideModal() {
        const m = modalStack.pop();
        if (m && m.parentNode) m.parentNode.removeChild(m);
    },
};

const dom = {
    content(el, content) {
        if (!el) return;
        for (const c of [...el.children]) c.parentNode = null;
        el.children = [];
        const add = (c) => {
            if (c === null || c === undefined || c === false) return;
            if (Array.isArray(c)) c.forEach(add);
            else el.appendChild(c);
        };
        add(content);
    },
};

const poll = {
    added: [],
    add(fn, interval) {
        this.added.push({ fn, interval });
    },
};

const view = { extend: (obj) => obj };
const baseclass = { extend: (obj) => obj };

// ---------------------------------------------------------------------------
// Fake ubus data (shaped like the real wifiroamd replies)
// ---------------------------------------------------------------------------
const MAC_CAP = 'aa:bb:cc:dd:ee:01';
const MAC_SAP = 'aa:bb:cc:dd:ee:02';
const MAC_PHONE = 'aa:bb:cc:dd:ee:11';
const MAC_PC = 'aa:bb:cc:dd:ee:12';

const FAKE = {
    status: {
        role: 'cap',
        version: 5,
        name: 'MainAP',
        ip: '192.168.1.1',
        peers_online: 1,
        peers_total: 2,
        clients_total: 3,
        roam: { enabled: true },
        last_apply: {
            ver: 2,
            results: [
                { name: 'Main AP', ap: MAC_CAP, ok: true, ver: 2 },
                { name: 'Sub AP', ap: MAC_SAP, ok: true, ver: 2 },
            ],
        },
        last_backhaul: {
            ver: 2,
            results: [{ name: 'Sub AP', ap: MAC_SAP, ok: true }],
        },
    },
    topology: {
        role: 'cap',
        self: 'ap1',
        name: 'MainAP',
        nodes: [
            {
                id: 'ap1', type: 'ap', name: 'Main AP', mac: MAC_CAP, ip: '192.168.1.1',
                model: 'Xiaomi AX6000', role: 'cap', uptime: 86400, firmware: 'ImmortalWrt 25.12',
                clients: [{ id: MAC_PHONE }, { id: MAC_PC }],
            },
            {
                id: 'ap2', type: 'ap', name: 'Sub AP', mac: MAC_SAP, ip: '192.168.1.2',
                model: 'Redmi AX6000', role: 'sap', uptime: 3600, firmware: 'ImmortalWrt 25.12',
                uplink: { type: 'wired', port: 'LAN1' },
                clients: [],
            },
            {
                id: MAC_PHONE, type: 'client', parent: 'ap1', name: 'iPhone', hostname: 'iPhone-de-xyz',
                mac: MAC_PHONE, ip: '192.168.1.101', online: true,
                conn: { type: 'wifi', band: '5g', ssid: 'TestNet', rssi: -55, tx_rate: 866.7, rx_speed: 120, tx_speed: 900 },
                last_online: NOW - 3600, last_offline: null, can_wake: false,
            },
            {
                id: MAC_PC, type: 'client', parent: 'ap1', name: 'ThinkPad', hostname: 'ThinkPad-X1',
                mac: MAC_PC, ip: '192.168.1.102', online: false,
                conn: { type: 'wired', port: 'LAN2' },
                last_online: NOW - 7200, last_offline: NOW - 600, can_wake: true,
            },
        ],
    },
    logs: [
        { type: 'client_join', ts: NOW - 60, name: 'iPhone', mac: MAC_PHONE, info: 'joined Main AP' },
        { type: 'roam_move', ts: NOW - 120, name: 'ThinkPad', mac: MAC_PC, info: 'Main AP -> Sub AP' },
    ],
    appctl: {
        ok: true, enabled: true, enhanced: false, strict: false, day: TODAY,
        devices: {}, stats: {}, online: {}, ndata: {},
        apps: [
            { id: 'wechat', name: 'WeChat', cat: 'social' },
            { id: 'douyin', name: 'Douyin', cat: 'video' },
        ],
    },
    roamCfg: {
        roam: {
            enabled: true, ssids: ['TestNet'], ft_mode: 'simple', r_fast: true,
            ft_over_ds: true, k_neighbor: true, k_beacon: true, v_bss_transition: true,
            rssi_profile: 'balanced', rssi_threshold: -70,
        },
        groups: [
            { ssid: 'TestNet', ap_count: 2, bands: ['2g', '5g'], encryptions: ['psk2'], consistent: true },
        ],
    },
    precheck: {
        role: 'cap',
        checks: [
            { id: 'wpad', ok: true, info: 'wpad full' },
            { id: 'ssid_group', ok: true, info: '2 APs' },
            { id: 'enc_consistent', ok: true, info: 'match' },
            { id: 'enc_allowed', ok: true, info: 'WPA2-PSK' },
            { id: 'role', ok: true, info: 'CAP' },
        ],
        aps: [
            { id: 'ap1', name: 'Main AP', mac: MAC_CAP, ip: '192.168.1.1', role: 'cap', online: true, self: true, ssids: ['TestNet'] },
            { id: 'ap2', name: 'Sub AP', mac: MAC_SAP, ip: '192.168.1.2', role: 'sap', online: true, ssids: ['TestNet'] },
        ],
    },
    backhaul: {
        backhaul: { enabled: true, ssid: 'wifiroam-bh', key: '', device: '' },
        radios: [{ name: 'wlan1', band: '5g', disabled: false }],
    },
    history: {
        devices: [
            {
                id: MAC_PHONE, mac: MAC_PHONE, name: 'iPhone', hostname: 'iPhone-de-xyz',
                ip: '192.168.1.101', online: true, ap: 'ap1', ap_name: 'Main AP',
                conn: { type: 'wifi', band: '5g', ssid: 'TestNet', rssi: -55, tx_rate: 866.7 },
                last_online: NOW - 3600, last_offline: null, can_wake: false,
                grouped: false, members: [], custom_name: null, pin: null, pin_name: null,
            },
            {
                id: MAC_PC, mac: MAC_PC, name: 'ThinkPad', hostname: 'ThinkPad-X1',
                ip: '192.168.1.102', online: false, ap: 'ap1', ap_name: 'Main AP',
                conn: { type: 'wired', port: 'LAN2' },
                last_online: NOW - 7200, last_offline: NOW - 600, can_wake: true,
                grouped: false, members: [], custom_name: null, pin: null, pin_name: null,
            },
        ],
        aps: [
            { id: 'ap1', name: 'Main AP' },
            { id: 'ap2', name: 'Sub AP' },
        ],
    },
    discover: {
        devices: [
            { name: 'New AP', model: 'Redmi AX6000', mac: 'aa:bb:cc:dd:ee:03', ip: '192.168.1.3', last_seen: NOW - 30 },
        ],
    },
    wifi: {
        role: 'cap', unified: true, ssid: 'TestNet',
        ifaces: [
            { band: '2g', ssid: 'TestNet' },
            { band: '5g', ssid: 'TestNet' },
        ],
        last: { results: [{ name: 'Main AP', ok: true }, { name: 'Sub AP', ok: null }] },
    },
    guest: {
        role: 'cap', enabled: true, ssid: 'GuestNet', has_key: true, bandwidth: 10,
        schedule: null, start: '08:00', end: '23:00',
    },
    offload: { enabled: false },
    ban_list: {
        ok: true, enabled: true,
        items: [{ mac: 'aabbccddee11', timeon: '22:00', timeoff: '07:00', weekdays: '1 2 3 4 5', active: false }],
    },
};

const rpcCalls = [];
const rpcHandlers = {
    wifiroam: {
        status: async () => FAKE.status,
        topology: async () => FAKE.topology,
        roam_log: async () => ({ events: FAKE.logs }),
        appctl_status: async () => FAKE.appctl,
        get_roam: async () => FAKE.roamCfg,
        precheck: async () => FAKE.precheck,
        get_backhaul: async () => FAKE.backhaul,
        device_history: async () => FAKE.history,
        discover: async () => FAKE.discover,
        get_wifi: async () => FAKE.wifi,
        get_guest: async () => FAKE.guest,
        offload_status: async () => FAKE.offload,
        ban_list: async () => FAKE.ban_list,
        set_alias: async () => ({ ok: true }),
        set_pin: async () => ({ ok: true }),
        set_ban: async () => ({ ok: true }),
        ban_set: async () => ({ ok: true }),
        ban_del: async () => ({ ok: true }),
        set_role: async () => ({ ok: true }),
        set_roam: async () => ({
            ok: true, ver: 3,
            results: [
                { name: 'Main AP', ap: MAC_CAP, ok: true },
                { name: 'Sub AP', ap: MAC_SAP, ok: true },
            ],
        }),
        set_backhaul: async () => ({
            ok: true, ver: 3, backhaul: { key: 'generated-key' },
            results: [{ name: 'Sub AP', ap: MAC_SAP, ok: true }],
        }),
        set_appctl: async (a) => ({ ok: true, enhanced: !!a.enhanced, strict: a.strict === true || a.strict === '1' }),
        set_app_policy: async () => ({ ok: true }),
        set_wifi: async () => ({ ok: true, results: [{ name: 'Main AP', ok: true }] }),
        set_guest: async () => ({ ok: true, results: [{ name: 'Main AP', ok: true }] }),
        set_offload: async () => ({ ok: true }),
        pair: async () => ({ ok: true }),
        unpair: async () => ({ ok: true }),
        ungroup_device: async () => ({ ok: true }),
        wake: async () => ({ ok: true }),
        client_detail: async () => ({ ok: true }),
    },
    service: {
        list: async () => ({ wifiroam: { instances: { i1: { running: true } } } }),
    },
    rc: {
        list: async () => ({ wifiroam: { enabled: true } }),
        init: async () => null, // serviceAction() treats any truthy reply as failure
    },
};

const rpc = {
    // Like LuCI's rpc.declare: a spec with params: ['name', ...] is called
    // positionally (callRcInit('wifiroam', 'restart')), while a spec whose
    // params were built from an object is called with that object
    // (common.call). Both shapes are normalised to a named-args object here.
    declare(spec) {
        return async (...callArgs) => {
            let args = {};
            if (spec.params && spec.params.length) {
                if (callArgs.length === 1 && callArgs[0] && typeof callArgs[0] === 'object' && !Array.isArray(callArgs[0]))
                    args = callArgs[0];
                else spec.params.forEach((p, i) => { if (callArgs[i] !== undefined) args[p] = callArgs[i]; });
            } else if (callArgs.length === 1 && callArgs[0] && typeof callArgs[0] === 'object') {
                args = callArgs[0];
            }
            rpcCalls.push({ object: spec.object, method: spec.method, args });
            const h = rpcHandlers[spec.object]?.[spec.method];
            if (!h) throw new Error('no mock handler for ' + spec.object + '.' + spec.method);
            return h(args);
        };
    },
};

// ---------------------------------------------------------------------------
// Module loader (LuCI modules are function bodies ending with `return ...`)
// ---------------------------------------------------------------------------
function loadModule(relPath, extra = {}) {
    const src = fs.readFileSync(staticPath(relPath), 'utf8');
    const params = ['view', 'ui', 'poll', 'dom', 'rpc', 'wr', 'oui', 'devices', 'logos', 'modelart', 'baseclass'];
    const fn = new Function(...params, src);
    return fn(
        view, ui, poll, dom, rpc,
        extra.wr ?? wr, extra.oui ?? oui, extra.devices ?? devices,
        extra.logos ?? logos, extra.modelart ?? modelart, baseclass,
    );
}

// Install LuCI globals, then load the shared modules once.
globalThis.E = E;
globalThis._ = _;
globalThis.L = L;
globalThis.document = document;
globalThis.window = window;
globalThis.confirm = (...a) => window.confirm(...a);
globalThis.MutationObserver = MutationObserver;

let wr, oui, devices, logos, modelart;
wr = loadModule('www/luci-static/resources/wifiroam/common.js');
oui = loadModule('www/luci-static/resources/wifiroam/oui.js');
devices = loadModule('www/luci-static/resources/wifiroam/devices.js');
logos = loadModule('www/luci-static/resources/wifiroam/logos.js');
modelart = loadModule('www/luci-static/resources/wifiroam/modelart.js');

// Tree helpers for assertions.
function textOf(root) {
    return root ? root.textContent : '';
}
function findAll(root, pred) {
    const out = [];
    const walk = (el) => {
        if (el.nodeType !== 1) return;
        if (pred(el)) out.push(el);
        for (const c of el.children) walk(c);
    };
    if (root) walk(root);
    return out;
}
function byClass(root, cls) {
    return findAll(root, (el) => el.classList.contains(cls));
}
function byText(root, text) {
    // Leaf elements only: a button's label is a text child, while ancestors
    // merely contain the same text.
    return findAll(
        root,
        (el) => el.textContent === text && el.children.every((c) => c.nodeType !== 1),
    );
}
function byId(root, id) {
    return findAll(root, (el) => el.getAttribute('id') === id)[0] || null;
}
function mount(root) {
    document.body.appendChild(root);
    return root;
}
function unmount(root) {
    if (root.parentNode) root.parentNode.removeChild(root);
}
function resetTestState() {
    poll.added.length = 0;
    rpcCalls.length = 0;
    confirmCalls.length = 0;
    reloadCalls.length = 0;
    timers.length = 0;
    // Clear the body except nothing: remove all mounted children.
    for (const c of [...document.body.children]) document.body.removeChild(c);
    modalStack.length = 0;
}

export { El, E, document, window, wr, oui, devices, logos, modelart, rpcCalls, FAKE };

// ---------------------------------------------------------------------------
// Data integrity (rewritten data files, evaluated)
// ---------------------------------------------------------------------------
test('data: oui keeps all 54,437 entries verbatim', () => {
    const entries = oui.data.split(';');
    assert.equal(entries.length, 54437);
    assert.equal(entries[0], '001bc5000:Converging Systems Inc.');
    assert.equal(entries[entries.length - 1], 'fcffaa:IEEE Registration Authority');
    assert.ok(entries.includes('fcfd71:AltoBeam Inc.'));
    assert.ok(!entries.some((e) => !e.includes(':')));
});

test('data: logos keeps all 75 brand paths', () => {
    assert.equal(Object.keys(logos.data).length, 75);
    assert.ok(logos.data.apple.startsWith('M12.152 6.896'));
    assert.ok(logos.data.huawei.includes('M3.67 6.14'));
});

test('data: modelart keeps base, 75 map keys and 94 token rules; every referenced PNG exists', () => {
    assert.equal(modelart.base, 'wifiroam/router/');
    assert.equal(Object.keys(modelart.map).length, 75);
    assert.equal(modelart.tokens.length, 94);
    assert.equal(modelart.map['Xiaomi AX6000'], '小米_AX6000.png');
    assert.equal(modelart.map['ASUS RT AC66U'], '华硕_RTAC66U.png');
    const refs = new Set([...Object.values(modelart.map), ...modelart.tokens.map((t) => t[2])]);
    assert.equal(refs.size, 96);
    for (const f of refs)
        assert.ok(fs.existsSync(staticPath('www/luci-static/resources/wifiroam/router/' + f)), f);
    assert.equal(fs.readdirSync(staticPath('www/luci-static/resources/wifiroam/router')).length, 101);
    assert.equal(fs.readdirSync(staticPath('www/luci-static/resources/wifiroam/apps')).length, 26);
});

test('data: devices keeps its pattern tables', () => {
    assert.equal(devices.NAME_VENDOR.length, 42);
    assert.equal(devices.NAME_KIND.length, 10);
    assert.equal(devices.VENDOR_KIND.length, 9);
    assert.equal(devices.nameVendor('iphone 15 pro'), 'Apple');
    assert.equal(devices.nameVendor('redmi note 13'), 'Xiaomi');
    assert.equal(devices.kindFor('Hikvision', 'DS-2CD'), 'camera');
});

// ---------------------------------------------------------------------------
// common.js helpers
// ---------------------------------------------------------------------------
test('common: formatters, weekday text, vendor lookup, status bar', () => {
    wr.useOui(oui.data);
    wr.useDevices(devices);
    wr.useVendorLogos(logos.data);
    assert.equal(wr.fmtBand('5g'), '5G');
    assert.equal(wr.fmtBand('2g'), '2.4G');
    assert.equal(wr.fmtBand('9g'), '9g');
    assert.ok(wr.fmtRate(866.7).includes('Mbit/s'));
    assert.ok(wr.fmtRate(1500).includes('Gbit/s'));
    assert.equal(wr.fmtRate(null), '-');
    assert.ok(wr.fmtTime(0).includes('1970'));
    assert.equal(wr.fmtDur(90), '1分');
    assert.equal(wr.fmtDur(3661), '1小时1分');
    assert.equal(wr.fmtBytes(2048), '2.0 KB');
    assert.equal(wr.fmtBytes(0), '0 B');
    assert.ok(wr.fmtAge(NOW - 30).endsWith('s'));
    assert.equal(wr.weekdayText([1, 2, 3, 4, 5]), 'Weekdays');
    assert.equal(wr.weekdayText([6, 7]), 'Weekend');
    assert.equal(wr.weekdayText([1, 2, 3, 4, 5, 6, 7]), 'Every day');
    assert.equal(wr.weekdayText([]), '-');
    assert.equal(wr.rssiClass(-55), 'wr-sig-good');
    assert.equal(wr.rssiClass(-80), 'wr-sig-bad');
    assert.equal(wr.rssiText(-55), '-55 dBm');

    const v = wr.vendorOf('fc:fd:71:00:00:01', '');
    assert.equal(v.name, 'AltoBeam Inc.');
    assert.equal(v.source, 'oui');
    const rnd = wr.vendorOf('02:00:00:00:00:01', '');
    assert.equal(rnd.name, 'Randomized MAC');
    assert.equal(rnd.random, true);
    const apple = wr.vendorOf('aa:bb:cc:dd:ee:11', 'iPhone 15');
    assert.equal(apple.brand, 'Apple');
    assert.ok(apple.logo && apple.logo.startsWith('M12.152'));

    const bar = wr.statusBar(FAKE.status);
    assert.ok(bar.classList.contains('wr-statusbar'));
    assert.ok(textOf(bar).includes('Main AP'));
    assert.ok(textOf(bar).includes('192.168.1.1'));
    assert.ok(textOf(bar).includes('1 / 2'));
    assert.ok(textOf(bar).includes('Enabled'));
});

test('common: safeCall resolves null on daemon failure; call records the method', async () => {
    resetTestState();
    const r = await wr.safeCall('no_such_method_xyz');
    assert.equal(r, null);
    await wr.call('status', {});
    assert.ok(rpcCalls.some((c) => c.object === 'wifiroam' && c.method === 'status'));
});

test('common: scheduleControls load/read/save/remove drive ban_set/ban_del', async () => {
    resetTestState();
    const ctl = wr.scheduleControls({ mac: 'aabbccddee11' });
    assert.equal(byClass(ctl.el, 'wr-wd-btn').length, 7);
    // NOTE: load() takes weekdays as an array here (the format weekdayPicker
    // works with). What the daemon actually returns in ban_list items is
    // recorded as an open question in the report, not changed in the rewrite.
    ctl.load({ mac: 'aabbccddee11', timeon: '22:00', timeoff: '07:00', weekdays: [1, 2, 3, 4, 5], active: false });
    assert.deepEqual(ctl.read(), { mac: 'aabbccddee11', timeon: '22:00', timeoff: '07:00', weekdays: '1 2 3 4 5' });
    const saved = await ctl.save({ name: 'iPhone' });
    assert.equal(saved.ok, true);
    assert.ok(rpcCalls.some((c) => c.method === 'ban_set' && c.args.mac === 'aabbccddee11' && c.args.name === 'iPhone'));
    const removed = await ctl.remove();
    assert.equal(removed.ok, true);
    assert.ok(rpcCalls.some((c) => c.method === 'ban_del' && c.args.mac === 'aabbccddee11'));
});

// ---------------------------------------------------------------------------
// settings page
// ---------------------------------------------------------------------------
function loadSettings() {
    return loadModule('www/luci-static/resources/view/wifiroam/settings.js');
}

test('settings: load -> render (CAP), poll 10s, hydrate fills the service panel', async () => {
    resetTestState();
    const page = loadSettings();
    const data = await page.load();
    assert.equal(data.length, 6);
    assert.equal(data[0].role, 'cap');
    assert.equal(data[2].ssid, 'TestNet');
    const root = mount(page.render(data));
    assert.equal(root.getAttribute('id'), 'wr-set');
    assert.deepEqual(poll.added.map((p) => p.interval), [10]);
    assert.ok(textOf(root).includes('Wi-Fi Settings'));
    assert.ok(textOf(root).includes('Guest'));
    assert.ok(textOf(root).includes('Hardware Acceleration'));
    assert.ok(textOf(root).includes('Member APs'));
    assert.ok(textOf(root).includes('New AP')); // discovered device row
    assert.ok(textOf(root).includes('Sub AP'));
    await settle();
    const svc = byId(document.body, 'wr-svc');
    assert.ok(svc && textOf(svc).includes('Plugin Service'));
    assert.ok(textOf(svc).includes('Running'));
    unmount(root);
});

test('settings: render without a daemon role shows the loading branch', async () => {
    resetTestState();
    const page = loadSettings();
    const root = mount(page.render([{}, {}, {}, {}, null, null]));
    assert.ok(textOf(root).includes('Cannot reach wifiroamd'));
    assert.ok(textOf(root).includes('Loading service status...'));
    unmount(root);
});

test('settings: version mismatch shows the repair warning', () => {
    resetTestState();
    const saved = FAKE.status.version;
    FAKE.status.version = 4;
    try {
        const page = loadSettings();
        const root = mount(page.render([FAKE.status, {}, FAKE.wifi, FAKE.guest, FAKE.discover, FAKE.topology]));
        assert.ok(textOf(root).includes('does not match this LuCI app'));
        unmount(root);
    } finally {
        FAKE.status.version = saved;
    }
});

test('settings: Save Wi-Fi validates, then calls set_wifi', async () => {
    resetTestState();
    const page = loadSettings();
    const data = await page.load();
    const root = mount(page.render(data));
    await settle();
    const saveBtn = byText(root, 'Save Wi-Fi')[0];
    assert.ok(saveBtn, 'Save Wi-Fi button present');
    // Validation: blank unified SSID is rejected, no ubus call.
    const uniSsid = findAll(root, (el) => el.tagName === 'INPUT' && el.getAttribute('placeholder') === 'Wi-Fi Name (SSID)')[0];
    uniSsid.value = '';
    saveBtn.dispatch('click');
    await settle();
    assert.ok(!rpcCalls.some((c) => c.method === 'set_wifi'));
    assert.ok(textOf(document.body).includes('SSID must be 1-32 characters'));
    // Valid save.
    uniSsid.value = 'TestNet';
    saveBtn.dispatch('click');
    await settle();
    const call = rpcCalls.find((c) => c.method === 'set_wifi');
    assert.ok(call);
    assert.equal(call.args.unified, true);
    assert.equal(call.args.ifaces.length, 2);
    assert.deepEqual(call.args.ifaces[0], { band: '2g', ssid: 'TestNet', key: '' });
    unmount(root);
});

test('settings: Pair button calls pair; Restart calls rc init', async () => {
    resetTestState();
    const page = loadSettings();
    const data = await page.load();
    const root = mount(page.render(data));
    await settle();
    const pairBtn = byText(root, 'Pair')[0];
    assert.ok(pairBtn, 'Pair button present');
    pairBtn.dispatch('click');
    await settle();
    assert.ok(rpcCalls.some((c) => c.method === 'pair' && c.args.mac === 'aa:bb:cc:dd:ee:03'));
    assert.ok(textOf(document.body).includes('Pairing request sent to'));
    const restartBtn = byText(root, 'Restart')[0];
    assert.ok(restartBtn, 'Restart button present');
    restartBtn.dispatch('click');
    await settle();
    assert.ok(rpcCalls.some((c) => c.object === 'rc' && c.method === 'init' && c.args.name === 'wifiroam' && c.args.action === 'restart'));
    assert.ok(textOf(document.body).includes('Service action applied'));
    unmount(root);
});

// ---------------------------------------------------------------------------
// advanced page
// ---------------------------------------------------------------------------
function loadAdvanced() {
    return loadModule('www/luci-static/resources/view/wifiroam/advanced.js');
}

test('advanced: load -> render, hydrate fills checks + backhaul, poll 15s', async () => {
    resetTestState();
    const page = loadAdvanced();
    const data = await page.load();
    assert.equal(data.length, 3);
    assert.equal(data[1].role, 'cap');
    const root = mount(page.render(data));
    assert.equal(root.getAttribute('id'), 'wr-adv');
    assert.deepEqual(poll.added.map((p) => p.interval), [15]);
    assert.ok(textOf(byId(document.body, 'wr-pre')).includes('Loading pre-flight checks...'));
    await settle();
    const pre = byId(document.body, 'wr-pre');
    assert.ok(textOf(pre).includes('Pre-flight Checks'));
    assert.equal(byClass(pre, 'wr-check-ok').length, 5);
    assert.ok(textOf(pre).includes('Main AP'));
    const bh = byId(document.body, 'wr-bh');
    assert.ok(textOf(bh).includes('Wireless Backhaul'));
    const bhSsid = findAll(bh, (el) => el.tagName === 'INPUT' && el.getAttribute('placeholder') === 'wifiroam-bh')[0];
    assert.ok(bhSsid, 'backhaul SSID input present');
    assert.equal(bhSsid.value, 'wifiroam-bh');
    assert.ok(textOf(root).includes('App Recognition & Statistics'));
    unmount(root);
});

test('advanced: render without roam config shows the unreachable branch', () => {
    resetTestState();
    const page = loadAdvanced();
    const root = mount(page.render([null, FAKE.status, FAKE.appctl]));
    assert.ok(textOf(root).includes('Cannot reach wifiroamd'));
    unmount(root);
});

test('advanced: apply() calls set_roam; applyBackhaul() calls set_backhaul; pollStatus refreshes', async () => {
    resetTestState();
    const page = loadAdvanced();
    const data = await page.load();
    const root = mount(page.render(data));
    await settle();
    await page.apply();
    await settle();
    const roamCall = rpcCalls.find((c) => c.method === 'set_roam');
    assert.ok(roamCall);
    assert.equal(roamCall.args.enabled, true);
    assert.deepEqual(roamCall.args.ssids, ['TestNet']);
    assert.equal(roamCall.args.ft_mode, 'simple');
    assert.equal(roamCall.args.rssi_threshold, -70);
    assert.ok(textOf(document.body).includes('Roaming configuration applied'));
    assert.ok(textOf(byId(document.body, 'wr-apply')).includes('Last Apply Result (v3)'));

    page.els.bhEnable.checked = true;
    page.els.bhSsid.value = 'wifiroam-bh';
    page.els.bhKey.value = '';
    await page.applyBackhaul();
    await settle();
    const bhCall = rpcCalls.find((c) => c.method === 'set_backhaul');
    assert.ok(bhCall);
    assert.equal(bhCall.args.enabled, true);
    assert.equal(bhCall.args.ssid, 'wifiroam-bh');
    assert.equal(page.st.last_backhaul.ver, 3);

    const nBefore = rpcCalls.filter((c) => c.method === 'status').length;
    await page.pollStatus();
    await settle();
    assert.ok(rpcCalls.filter((c) => c.method === 'status').length > nBefore);
    unmount(root);
});

// ---------------------------------------------------------------------------
// clients page
// ---------------------------------------------------------------------------
function loadClients() {
    return loadModule('www/luci-static/resources/view/wifiroam/clients.js');
}

test('clients: load -> render -> cards, count, filter, refresh', async () => {
    resetTestState();
    const page = loadClients();
    const data = await page.load();
    assert.ok(Array.isArray(data.devices) && data.devices.length === 2);
    const root = mount(page.render(data));
    assert.deepEqual(poll.added.map((p) => p.interval), [15]);
    await settle(); // the 0ms renderCards timer
    assert.equal(byClass(document.body, 'wr-dcard').length, 2);
    assert.ok(textOf(byId(document.body, 'wr-count')).includes('1 online / 2 total'));
    assert.ok(textOf(document.body).includes('iPhone'));
    assert.ok(textOf(document.body).includes('ThinkPad'));
    // Apple logo path is embedded in the iPhone avatar svg.
    const svgPaths = findAll(document.body, (el) => el.tagName === 'PATH').map((el) => el.getAttribute('d') || '');
    assert.ok(svgPaths.some((d) => d.startsWith('M12.152 6.896')));
    // Filter.
    page.filterText = 'thinkpad';
    page.renderCards();
    assert.equal(byClass(document.body, 'wr-dcard').length, 1);
    assert.ok(textOf(document.body).includes('ThinkPad'));
    page.filterText = '';
    page.renderCards();
    assert.equal(byClass(document.body, 'wr-dcard').length, 2);
    // Refresh re-reads device_history.
    const nBefore = rpcCalls.filter((c) => c.method === 'device_history').length;
    await page.refresh();
    await settle();
    assert.ok(rpcCalls.filter((c) => c.method === 'device_history').length > nBefore);
    unmount(root);
});

test('clients: rename edit calls set_alias; Wake on LAN calls wake', async () => {
    resetTestState();
    const page = loadClients();
    const data = await page.load();
    const root = mount(page.render(data));
    await settle();
    page.editing[MAC_PHONE] = true;
    page.renderCards();
    const input = byClass(document.body, 'wr-dcard-input')[0];
    assert.ok(input, 'rename input present');
    input.value = 'My iPhone';
    const saveBtn = byText(document.body, 'Save')[0];
    assert.ok(saveBtn, 'Save button present');
    saveBtn.dispatch('click');
    await settle();
    const alias = rpcCalls.find((c) => c.method === 'set_alias');
    assert.ok(alias);
    assert.deepEqual(alias.args, { mac: MAC_PHONE, name: 'My iPhone' });
    assert.equal(page.editing[MAC_PHONE], undefined);
    assert.ok(textOf(document.body).includes('My iPhone'));

    const wakeBtn = byText(document.body, 'Wake on LAN')[0];
    assert.ok(wakeBtn, 'Wake on LAN button present');
    wakeBtn.dispatch('click');
    await settle();
    assert.ok(rpcCalls.some((c) => c.method === 'wake' && c.args.mac === MAC_PC));
    assert.ok(textOf(document.body).includes('Magic packet sent'));
    unmount(root);
});

test('clients: render with no daemon data shows the unreachable branch', () => {
    resetTestState();
    const page = loadClients();
    const root = mount(page.render(null));
    assert.ok(textOf(root).includes('Cannot reach wifiroamd'));
    unmount(root);
});

// ---------------------------------------------------------------------------
// topology page
// ---------------------------------------------------------------------------
function loadTopology() {
    return loadModule('www/luci-static/resources/view/wifiroam/topology.js');
}

function topoClientNode() {
    return FAKE.topology.nodes.find((n) => n.type === 'client' && n.mac === MAC_PHONE);
}

test('topology: load -> render -> fetch redraws SVG + log, poll 15s', async () => {
    resetTestState();
    const page = loadTopology();
    const data = await page.load();
    assert.equal(data.length, 4);
    assert.equal(data[0].role, 'cap');
    const root = mount(page.render(data));
    assert.deepEqual(poll.added.map((p) => p.interval), [15]);
    assert.ok(byId(document.body, 'wr-topo'), '#wr-topo present');
    await page.fetch();
    await settle();
    const topoBox = byId(document.body, 'wr-topo');
    assert.ok(findAll(topoBox, (el) => el.tagName === 'SVG').length >= 1, 'topology SVG drawn');
    assert.ok(textOf(topoBox).includes('iPhone'));
    assert.ok(textOf(topoBox).includes('ThinkPad'));
    assert.ok(textOf(topoBox).includes('Main AP'));
    // Router photo: the CAP art references the modelart-mapped PNG.
    const imgs = findAll(topoBox, (el) => el.tagName === 'IMAGE');
    assert.ok(imgs.some((im) => (im.getAttribute('href') || '').includes('%E5%B0%8F%E7%B1%B3_AX6000.png') || (im.getAttribute('href') || '').includes('AX6000.png')));
    const log = byId(document.body, 'wr-log');
    assert.ok(textOf(log).includes('匹配 2 / 共 2 条'));
    assert.ok(textOf(log).includes('joined Main AP'));
    const ts = byId(document.body, 'wr-refresh-ts');
    assert.ok(textOf(ts).includes('Updated'));
    // Layout math sanity.
    const lay = page.layout();
    assert.ok(lay.W >= 840);
    assert.ok(lay.pos.ap1 && lay.pos.ap2 && lay.pos[MAC_PHONE]);
    unmount(root);
});

test('topology: theme switch persists; detail dialog opens with stats/schedule/appctl', async () => {
    resetTestState();
    const page = loadTopology();
    const data = await page.load();
    const root = mount(page.render(data));
    await page.fetch();
    await settle();
    const themeSel = byClass(document.body, 'wr-theme-sel')[0];
    assert.ok(themeSel, 'theme selector present');
    themeSel.value = 'dark';
    themeSel.dispatch('change');
    assert.equal(page.themeId, 'dark');
    assert.equal(window.localStorage.getItem('wr.topo.theme'), 'dark');

    page.openDetail(topoClientNode());
    await settle();
    assert.equal(page.modalOpen, true);
    const modal = document.querySelector('.modal');
    assert.ok(modal, 'detail modal present');
    assert.ok(textOf(modal).includes('Usage stats'));
    assert.ok(textOf(modal).includes('Internet Schedule'));
    assert.ok(rpcCalls.some((c) => c.method === 'ban_list'), 'scheduleBox read ban_list');
    const closeBtn = byText(modal, 'Close')[0];
    assert.ok(closeBtn, 'Close button present');
    closeBtn.dispatch('click');
    assert.equal(document.querySelector('.modal'), null);
    assert.equal(page.modalOpen, false);
    unmount(root);
});

test('topology: donate dialog shows the QR image; unreachable topo renders the empty state', async () => {
    resetTestState();
    const page = loadTopology();
    const data = await page.load();
    const root = mount(page.render(data));
    page.openDonate();
    await settle();
    const modal = document.querySelector('.modal');
    assert.ok(modal, 'donate modal present');
    const img = findAll(modal, (el) => el.tagName === 'IMG')[0];
    assert.ok(img && img.getAttribute('src').includes('donate-qr.png'));
    ui.hideModal();
    assert.equal(document.querySelector('.modal'), null);

    // Unreachable daemon: fetch() redraws the empty state into #wr-topo.
    // (The donate dialog leaves modalOpen set; the next fetch clears it.
    // Reset it here so redraw() itself is what is being exercised.)
    page.modalOpen = false;
    page.topo = null;
    page.status = FAKE.status;
    page.logs = [];
    page.redraw();
    assert.ok(textOf(byId(document.body, 'wr-topo')).includes('Cannot reach wifiroamd'));
    unmount(root);
});

// ---------------------------------------------------------------------------
// ubus coverage: every read method the pages use is exercised
// ---------------------------------------------------------------------------
test('ubus: all read methods used by the four pages are called', async () => {
    resetTestState();
    const settings = loadSettings();
    const advanced = loadAdvanced();
    const clients = loadClients();
    const topology = loadTopology();
    const sData = await settings.load();
    const aData = await advanced.load();
    const cData = await clients.load();
    const tData = await topology.load();
    const sRoot = mount(settings.render(sData));
    const aRoot = mount(advanced.render(aData));
    const cRoot = mount(clients.render(cData));
    const tRoot = mount(topology.render(tData));
    await settle();
    await topology.fetch();
    await settle();
    topology.openDetail(FAKE.topology.nodes.find((n) => n.type === 'client' && n.mac === MAC_PHONE));
    await settle();
    await clients.refresh();
    await settle();
    const methods = new Set(rpcCalls.filter((c) => c.object === 'wifiroam').map((c) => c.method));
    for (const m of [
        'status', 'topology', 'device_history', 'get_roam', 'precheck', 'discover',
        'roam_log', 'get_backhaul', 'appctl_status', 'get_wifi', 'get_guest',
        'offload_status', 'ban_list',
    ]) {
        assert.ok(methods.has(m), 'ubus method exercised: ' + m);
    }
    assert.ok(rpcCalls.some((c) => c.object === 'service' && c.method === 'list'));
    assert.ok(rpcCalls.some((c) => c.object === 'rc' && c.method === 'list'));
    unmount(sRoot);
    unmount(aRoot);
    unmount(cRoot);
    unmount(tRoot);
});
