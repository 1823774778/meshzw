/*
 * wifiroam LuCI frontend - readable rewrite of luci-app-wifiroam 0.261115.15302.
 *
 * Only the dense one-line layout was re-laid-out (indentation, line breaks,
 * section notes). No logic, text, class name, element id, ubus call,
 * parameter, polling interval or button action was changed.
 */
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';
'require wifiroam.oui as oui';
'require wifiroam.logos as logos';
'require wifiroam.devices as devices';
'require wifiroam.modelart as modelart';
var SVGNS = 'http://www.w3.org/2000/svg';
wr.useOui(oui.data);
wr.useVendorLogos(logos.data);
wr.useDevices(devices);
var LAY = {
    rootY: 100,
    apY: 306,
    clY0: 470,
    clStep: 104,
    laneW: 212,
    minW: 840,
    margin: 18,
    clGap: 118,
    clPerRow: 5,
};
var THEMES = {
    classic: {
        label: '经典',
        ap: 'icon',
        client: 'card',
        linkTop: 86,
        apG: ['#ffffff', '#e3edfb'],
        capG: ['#ffffff', '#dff2e3'],
        apStroke: '#1565c0',
        capStroke: '#2e7d32',
    },
    map: {
        label: '拓扑地图',
        ap: 'card',
        client: 'badge',
        linkTop: 52,
        apG: ['#ffffff', '#f8fafc'],
        capG: ['#ffffff', '#f6f2ff'],
        apStroke: '#3f9e8a',
        capStroke: '#7a5cf0',
    },
    dark: {
        label: '深色',
        ap: 'icon',
        client: 'card',
        linkTop: 86,
        apG: ['#1b2c46', '#122036'],
        capG: ['#133a2b', '#0f2b21'],
        apStroke: '#4b7fbf',
        capStroke: '#3fae8f',
    },
    minimal: {
        label: '极简',
        ap: 'icon',
        client: 'card',
        linkTop: 86,
        apG: ['#ffffff', '#f5f8fc'],
        capG: ['#ffffff', '#f4faf6'],
        apStroke: '#b9c7d6',
        capStroke: '#9bd0b6',
    },
};
var THEME_IDS = ['classic', 'map', 'dark', 'minimal'];
var ROUTER_ART = [
    {
        name: 'Super Gateway S20P',
        re: /s20p|super\s*gateway/i,
        body: '#37474f',
        edge: '#263238',
        panel: '#51646e',
        ants: 4,
        tower: false,
        led: '#4fc3f7',
        ledN: 4,
    },
    {
        name: 'JDCloud RE-CS-02',
        re: /re[-_\s]?cs[-_\s]?02/i,
        body: '#ffffff',
        edge: '#9fb0c2',
        panel: '#dde6f0',
        ants: 2,
        tower: true,
        led: '#e1251b',
        ledN: 1,
    },
    {
        name: 'JDCloud RE-SS-01',
        re: /re[-_\s]?ss[-_\s]?01/i,
        body: '#ffffff',
        edge: '#9fb0c2',
        panel: '#dde6f0',
        ants: 0,
        tower: false,
        led: '#34a853',
        ledN: 1,
    },
];
var ROUTER_ART_FALLBACK = {
    name: '',
    body: '#ffffff',
    edge: '#b0bec5',
    panel: '#eceff1',
    ants: 2,
    tower: false,
    led: '#4fc3f7',
    ledN: 2,
};
function routerArtSpec(model) {
    var m = String(model || '');
    for (var i = 0; i < ROUTER_ART.length; i++) if (ROUTER_ART[i].re.test(m)) return ROUTER_ART[i];
    return ROUTER_ART_FALLBACK;
}
function routerPhoto(model) {
    var m = String(model || '');
    if (!m) return null;
    if (modelart.map[m]) return modelart.map[m];
    var low = m.toLowerCase();
    for (var i = 0; i < modelart.tokens.length; i++) {
        var t = modelart.tokens[i];
        if (low.indexOf(t[0]) >= 0 && low.indexOf(t[1]) >= 0) return t[2];
    }
    return null;
}
var EVENT_TEXT = {
    client_join: _('Client joined'),
    client_leave: _('Client left'),
    roam_move: _('Roamed'),
    roam_steer: _('Steering requested'),
    roam_kick: _('Forced reconnect'),
    ap_online: _('AP online'),
    ap_offline: _('AP offline'),
    paired: _('Paired'),
    unpaired: _('Unpaired'),
    roam_apply: _('Roaming applied'),
    backhaul_apply: _('Backhaul applied'),
    backhaul_link: _('Backhaul link changed'),
    cap_connected: _('Connected to main AP'),
    peer_event: _('Peer event'),
};
function svg(tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs) {
        Object.keys(attrs).forEach(function (k) {
            if (attrs[k] != null) n.setAttribute(k, attrs[k]);
        });
    }
    if (text != null) n.textContent = text;
    return n;
}
function deviceKind(n) {
    var c = n.conn || {};
    var v = wr.vendorOf(n.mac, (n.hostname || '') + ' ' + (n.name || ''));
    var kind = wr.kindOf(v && v.name, (n.name || '') + ' ' + (n.hostname || ''));
    if (kind) return kind;
    if (c.type !== 'wifi') return 'wired';
    return 'generic';
}
function estTextWidth(s) {
    var w = 0;
    for (var i = 0; i < s.length; i++) w += s.charCodeAt(i) > 0x2e80 ? 12.5 : 6.6;
    return w;
}
function fitText(s, maxW) {
    if (estTextWidth(s) * 1.15 <= maxW) return s;
    var budget = maxW - 7;
    var acc = 0,
        out = '';
    for (var i = 0; i < s.length; i++) {
        var cw = (s.charCodeAt(i) > 0x2e80 ? 12.5 : 6.6) * 1.15;
        if (acc + cw > budget) break;
        out += s.charAt(i);
        acc += cw;
    }
    return out.replace(/[\s,，、._-]+$/, '') + '…';
}
function signalColor(rssi) {
    if (rssi == null) return '#cfd8dc';
    if (rssi >= -60) return '#43a047';
    if (rssi >= -72) return '#fb8c00';
    return '#e53935';
}
function safeCall(method, args) {
    return wr.call(method, args).catch(function () {
        return null;
    });
}
function clientKey(n) {
    var id = (n.id || n.mac || '').toLowerCase();
    if (/^g[0-9a-f]{12}$/.test(id)) return id;
    return id.replace(/[^0-9a-f]/g, '');
}
var APP_ICONS = {
    wechat: 'wechat',
    qq: 'qq',
    douyin: 'douyin',
    kuaishou: 'kuaishou',
    bilibili: 'bilibili',
    xiaohongshu: 'xiaohongshu',
    weibo: 'weibo',
    taobao: 'taobao',
    iqiyi: 'iqiyi',
    netease_music: 'netease_music',
    youku: 'youku',
    mgtv: 'mgtv',
    zhihu: 'zhihu',
    toutiao: 'toutiao',
    xigua: 'xigua',
    jd: 'jd',
    pinduoduo: 'pinduoduo',
    meituan: 'meituan',
    eleme: 'eleme',
    dingtalk: 'dingtalk',
    baidu: 'baidu',
    ximalaya: 'ximalaya',
    huya: 'huya',
    douyu: 'douyu',
    mihoyo: 'mihoyo',
    kugou: 'kugou',
};
var CAT_ORDER = [
    'video',
    'live',
    'social',
    'shop',
    'music',
    'news',
    'office',
    'game',
    'web',
    'iot',
];
var CAT_NAME = {
    video: _('Video'),
    live: _('Live'),
    social: _('Social'),
    shop: _('Shopping'),
    music: _('Music'),
    news: _('News'),
    office: _('Office'),
    game: _('Games'),
    web: _('Web'),
    iot: _('Smart Home'),
};
function appIcon(id) {
    var file = APP_ICONS[id];
    if (!file) return null;
    return E('img', {
        class: 'wr-app-ico',
        src: L.resource('wifiroam/apps/' + file + '.png'),
        alt: '',
        'aria-hidden': 'true',
        style:
            'width:18px;height:18px;border-radius:4px;object-fit:contain;' +
            'flex:0 0 18px;display:inline-block;vertical-align:middle',
    });
}
function appCell(id, name, live) {
    return E(
        'div',
        {
            class: 'wr-app-cell',
            style: 'display:flex;align-items:center;gap:0.45em;white-space:nowrap',
        },
        [
            appIcon(id),
            live
                ? E('span', { class: 'wr-app-live', title: _('In use'), style: 'flex:0 0 7px' })
                : null,
            E('span', { class: 'wr-app-name', style: 'line-height:1.35' }, name),
        ],
    );
}
return view.extend({
    topo: null,
    status: null,
    logs: [],
    modalOpen: false,
    collapsed: {},
    fetchSeq: 0,
    appctlReq: 0,
    appctlSaving: 0,
    load: function () {
        return Promise.all([
            safeCall('topology'),
            safeCall('status'),
            safeCall('roam_log', { limit: 60 }),
            safeCall('appctl_status'),
        ]);
    },
    fetch: function () {
        if (this.modalOpen && !document.querySelector('.modal')) this.modalOpen = false;
        var seq = ++this.fetchSeq;
        return this.load().then(
            L.bind(function (res) {
                if (seq !== this.fetchSeq) return;
                this.topo = res[0];
                this.status = res[1];
                this.logs = (res[2] && res[2].events) || [];
                if (!this.appctlSaving) this.appctl = res[3] || null;
                this.redraw();
                if (this._appRedraw && document.querySelector('.wr-appctl')) this._appRedraw();
                if (this._statsRedraw && document.querySelector('.wr-stats')) this._statsRedraw();
                if (this._ratesRedraw && document.querySelector('.wr-dev-rates'))
                    this._ratesRedraw();
                var ts = document.getElementById('wr-refresh-ts');
                if (ts)
                    ts.textContent = _('Updated') + ' ' + wr.fmtTime(Math.floor(Date.now() / 1000));
            }, this),
        );
    },
    refresh: function (btn) {
        var started = Date.now();
        wr.setBusy(btn, true, _('Refreshing...'));
        function done() {
            wr.setBusy(btn, false);
            var box = document.getElementById('wr-topo');
            if (box) {
                box.classList.remove('wr-flash');
                void box.offsetWidth;
                box.classList.add('wr-flash');
            }
            wr.notify('success', _('Topology refreshed'));
        }
        return this.fetch()
            .then(function () {
                var wait = 400 - (Date.now() - started);
                return new Promise(function (resolve) {
                    window.setTimeout(resolve, wait > 0 ? wait : 0);
                });
            })
            .then(done)
            .catch(function () {
                wr.setBusy(btn, false);
                wr.notify('danger', _('Refresh failed'));
            });
    },
    // ---- SVG layout: lanes for CAP / SAPs / clients ----
    layout: function () {
        var nodes = (this.topo && this.topo.nodes) || [];
        var aps = nodes.filter(function (n) {
            return n.type === 'ap';
        });
        var clients = nodes.filter(function (n) {
            return n.type === 'client';
        });
        var col = this.collapsed;
        var root = null;
        aps.forEach(function (a) {
            if (!root && a.role === 'cap') root = a;
        });
        if (!root && aps.length) root = aps[0];
        if (!root)
            return {
                pos: {},
                byParent: {},
                root: null,
                saps: [],
                clients: [],
                W: LAY.minW,
                H: 240,
            };
        var saps = aps.filter(function (a) {
            return a !== root;
        });
        saps.sort(function (a, b) {
            return (a.name || '').localeCompare(b.name || '');
        });
        var byParent = {};
        clients.forEach(function (c) {
            (byParent[c.parent] = byParent[c.parent] || []).push(c);
        });
        Object.keys(byParent).forEach(function (k) {
            byParent[k].sort(function (a, b) {
                var aW = a.conn && a.conn.type === 'wifi' ? 0 : 1;
                var bW = b.conn && b.conn.type === 'wifi' ? 0 : 1;
                if (aW !== bW) return aW - bW;
                return (a.name || '').localeCompare(b.name || '');
            });
        });
        var order = saps.slice();
        order.splice(Math.floor((saps.length + 1) / 2), 0, root);
        var laneInfo = {};
        order.forEach(function (ap) {
            var kids = col[ap.id] ? [] : byParent[ap.id] || [];
            var wifiN = 0;
            kids.forEach(function (c) {
                if (c.conn && c.conn.type === 'wifi') wifiN++;
            });
            var wiredN = kids.length - wifiN;
            var leftW, rightW;
            if (wifiN && wiredN) {
                leftW = Math.min(wifiN, LAY.clPerRow) * LAY.clGap;
                rightW = Math.min(wiredN, LAY.clPerRow) * LAY.clGap;
            } else {
                var n = Math.min(kids.length, LAY.clPerRow);
                leftW = rightW = Math.max(LAY.laneW, n * LAY.clGap) / 2;
            }
            laneInfo[ap.id] = { left: leftW, right: rightW };
        });
        var x = 0;
        var pos = {};
        order.forEach(function (ap) {
            var li = laneInfo[ap.id];
            pos[ap.id] = { x: x + li.left, y: ap === root ? LAY.rootY : LAY.apY };
            x += li.left + li.right;
        });
        var W = Math.max(LAY.minW, x + 2 * LAY.margin);
        var shift = LAY.margin + (W - 2 * LAY.margin - x) / 2;
        Object.keys(pos).forEach(function (id) {
            pos[id].x += shift;
        });
        var maxRows = 1;
        Object.keys(byParent).forEach(function (pid) {
            if (col[pid]) return;
            var list = byParent[pid];
            var ax = pos[pid] ? pos[pid].x : W / 2;
            var wifi = [],
                wired = [];
            list.forEach(function (c) {
                if (c.conn && c.conn.type === 'wifi') wifi.push(c);
                else wired.push(c);
            });
            if (wifi.length && wired.length) {
                wifi.forEach(function (c, i) {
                    var row = Math.floor(i / LAY.clPerRow);
                    var cnt = Math.min(LAY.clPerRow, wifi.length - row * LAY.clPerRow);
                    var k = i % LAY.clPerRow;
                    maxRows = Math.max(maxRows, row + 1);
                    pos[c.id] = {
                        x: ax - (cnt - k - 0.5) * LAY.clGap,
                        y: LAY.clY0 + row * LAY.clStep,
                    };
                });
                wired.forEach(function (c, i) {
                    var row = Math.floor(i / LAY.clPerRow);
                    var k = i % LAY.clPerRow;
                    maxRows = Math.max(maxRows, row + 1);
                    pos[c.id] = { x: ax + (k + 0.5) * LAY.clGap, y: LAY.clY0 + row * LAY.clStep };
                });
                return;
            }
            list.forEach(function (c, i) {
                var row = Math.floor(i / LAY.clPerRow);
                var cnt = Math.min(LAY.clPerRow, list.length - row * LAY.clPerRow);
                var colIdx = i % LAY.clPerRow;
                maxRows = Math.max(maxRows, row + 1);
                pos[c.id] = {
                    x: ax + (colIdx - (cnt - 1) / 2) * LAY.clGap,
                    y: LAY.clY0 + row * LAY.clStep,
                };
            });
        });
        return {
            pos: pos,
            byParent: byParent,
            root: root,
            saps: saps,
            clients: clients,
            W: W,
            H: LAY.clY0 + (maxRows - 1) * LAY.clStep + 120,
        };
    },
    routerArt: function (g, cx, cy, k, a, isCap, accent, withBadge) {
        var photo = routerPhoto(a.model);
        if (photo) {
            this.routerPhotoArt(g, cx, cy, k, a, isCap, accent, withBadge, photo);
            return;
        }
        var sp = routerArtSpec(a.model);
        function X(v) {
            return cx + v * k;
        }
        function Y(v) {
            return cy + v * k;
        }
        function S(v) {
            return v * k;
        }
        var sw = Math.max(1, 1.5 * k);
        var art = svg('g', { class: 'wr-ap-art' });
        art.appendChild(svg('title', {}, sp.name || a.model || (isCap ? 'CAP' : 'AP')));
        if (sp.ants > 0) {
            var xs = sp.tower ? [-15, 15] : sp.ants >= 4 ? [-20, -13, 13, 20] : [-19, 19];
            var tipY = sp.tower ? -19 : -18;
            var baseY = sp.tower ? -8 : 2;
            xs.forEach(function (dx) {
                art.appendChild(
                    svg('line', {
                        x1: X(dx),
                        y1: Y(baseY),
                        x2: X(dx),
                        y2: Y(tipY),
                        stroke: sp.edge,
                        'stroke-width': sw,
                        'stroke-linecap': 'round',
                    }),
                );
                art.appendChild(
                    svg('circle', {
                        cx: X(dx),
                        cy: Y(tipY),
                        r: S(1.5),
                        fill: sp.edge,
                        stroke: 'none',
                    }),
                );
            });
        }
        var bw = sp.tower ? 22 : 38;
        var bh = sp.tower ? 28 : 16;
        var by = sp.tower ? -10 : 1;
        art.appendChild(
            svg('rect', {
                x: X(-bw / 2),
                y: Y(by),
                width: S(bw),
                height: S(bh),
                rx: S(sp.tower ? 4 : 3),
                fill: sp.body,
                stroke: sp.edge,
                'stroke-width': sw,
                filter: k >= 0.85 ? 'url(#wrShadow)' : null,
            }),
        );
        art.appendChild(
            svg('rect', {
                x: X(-bw / 2 + 2),
                y: Y(by + 2),
                width: S(bw - 4),
                height: S(sp.tower ? 7 : 4),
                rx: S(1.6),
                fill: sp.panel,
                stroke: 'none',
                opacity: sp.body === '#ffffff' ? '0.85' : '0.55',
            }),
        );
        if (!sp.tower) {
            for (var v = 0; v < 3; v++) {
                art.appendChild(
                    svg('line', {
                        x1: X(-14),
                        y1: Y(by + 7 + v * 3.2),
                        x2: X(-5),
                        y2: Y(by + 7 + v * 3.2),
                        stroke: sp.edge,
                        'stroke-width': Math.max(0.9, 1.3 * k),
                        'stroke-linecap': 'round',
                        opacity: '0.8',
                    }),
                );
            }
        }
        for (var i = 0; i < sp.ledN; i++) {
            var lx = sp.tower ? 0 : 12 - i * 4.5;
            art.appendChild(
                svg('circle', {
                    cx: X(lx),
                    cy: Y(by + bh - 4),
                    r: S(1.4),
                    fill: sp.led,
                    stroke: 'none',
                }),
            );
        }
        if (withBadge) {
            art.appendChild(
                svg('circle', {
                    cx: X(-bw / 2 + 2),
                    cy: Y(by + 3),
                    r: S(7.6),
                    fill: accent,
                    stroke: '#fff',
                    'stroke-width': Math.max(1.2, 1.6 * k),
                }),
            );
            art.appendChild(
                svg(
                    'text',
                    {
                        x: X(-bw / 2 + 2),
                        y: Y(by + 3) + S(3.2),
                        style:
                            'fill:#fff;stroke:none;font-size:' +
                            Math.max(8, S(9)) +
                            'px;font-weight:700;text-anchor:middle',
                    },
                    isCap ? 'C' : 'S',
                ),
            );
        }
        g.appendChild(art);
    },
    routerPhotoArt: function (g, cx, cy, k, a, isCap, accent, withBadge, file) {
        var w = 104 * k,
            h = 56 * k;
        var art = svg('g', { class: 'wr-ap-art wr-ap-photo' });
        art.appendChild(svg('title', {}, a.model || (isCap ? 'CAP' : 'AP')));
        art.appendChild(
            svg('image', {
                href: L.resource(modelart.base + encodeURIComponent(file)),
                x: cx - w / 2,
                y: cy - h / 2,
                width: w,
                height: h,
                preserveAspectRatio: 'xMidYMid meet',
                filter: k >= 0.85 ? 'url(#wrShadow)' : null,
            }),
        );
        if (withBadge) {
            var bx = cx - w / 2 + 2,
                by = cy - h / 2 + 3;
            art.appendChild(
                svg('circle', {
                    cx: bx,
                    cy: by,
                    r: 8 * k,
                    fill: accent,
                    stroke: '#fff',
                    'stroke-width': Math.max(1.2, 1.6 * k),
                }),
            );
            art.appendChild(
                svg(
                    'text',
                    {
                        x: bx,
                        y: by + 3.4 * k,
                        style:
                            'fill:#fff;stroke:none;font-size:' +
                            Math.max(8, 9 * k) +
                            'px;font-weight:700;text-anchor:middle',
                    },
                    isCap ? 'C' : 'S',
                ),
            );
        }
        g.appendChild(art);
    },
    apIcon: function (g, p, a, color) {
        var isCap = a.role === 'cap';
        var accent = color || (isCap ? '#2e7d32' : '#1565c0');
        this.routerArt(g, p.x, p.y + 2, 0.92, a, isCap, accent, true);
    },
    glyph: function (g, x, y, kind) {
        var box = { fill: '#eceff1', stroke: '#546e7a', 'stroke-width': 1.6 };
        var plate = { fill: '#cfd8dc', stroke: '#78909c', 'stroke-width': 1.2 };
        switch (kind) {
            case 'laptop':
                g.appendChild(
                    svg('rect', {
                        x: x - 10,
                        y: y - 5,
                        width: 20,
                        height: 12,
                        rx: 2,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': box['stroke-width'],
                    }),
                );
                g.appendChild(
                    svg('path', {
                        d:
                            'M ' +
                            (x - 13) +
                            ' ' +
                            (y + 9) +
                            ' L ' +
                            (x + 13) +
                            ' ' +
                            (y + 9) +
                            ' L ' +
                            (x + 10) +
                            ' ' +
                            (y + 5) +
                            ' L ' +
                            (x - 10) +
                            ' ' +
                            (y + 5) +
                            ' Z',
                        fill: plate.fill,
                        stroke: plate.stroke,
                        'stroke-width': plate['stroke-width'],
                    }),
                );
                break;
            case 'phone':
                g.appendChild(
                    svg('rect', {
                        x: x - 6.5,
                        y: y - 11,
                        width: 13,
                        height: 22,
                        rx: 3,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('line', {
                        x1: x - 2.5,
                        y1: y - 8,
                        x2: x + 2.5,
                        y2: y - 8,
                        stroke: '#78909c',
                        'stroke-width': 1.3,
                    }),
                );
                g.appendChild(
                    svg('circle', { cx: x, cy: y + 8, r: 1.3, fill: '#78909c', stroke: 'none' }),
                );
                break;
            case 'tablet':
                g.appendChild(
                    svg('rect', {
                        x: x - 9,
                        y: y - 11,
                        width: 18,
                        height: 22,
                        rx: 2.5,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('line', {
                        x1: x - 4,
                        y1: y + 8,
                        x2: x + 4,
                        y2: y + 8,
                        stroke: '#78909c',
                        'stroke-width': 1.3,
                    }),
                );
                break;
            case 'tv':
                g.appendChild(
                    svg('rect', {
                        x: x - 11,
                        y: y - 9,
                        width: 22,
                        height: 14,
                        rx: 2,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('path', {
                        d:
                            'M ' +
                            (x - 4) +
                            ' ' +
                            (y + 5) +
                            ' L ' +
                            (x + 4) +
                            ' ' +
                            (y + 5) +
                            ' L ' +
                            (x + 6) +
                            ' ' +
                            (y + 9) +
                            ' L ' +
                            (x - 6) +
                            ' ' +
                            (y + 9) +
                            ' Z',
                        fill: plate.fill,
                        stroke: plate.stroke,
                        'stroke-width': plate['stroke-width'],
                    }),
                );
                break;
            case 'nas':
                [-10, -3, 4].forEach(function (dy) {
                    g.appendChild(
                        svg('rect', {
                            x: x - 9,
                            y: y + dy,
                            width: 18,
                            height: 6,
                            rx: 1.5,
                            fill: box.fill,
                            stroke: box.stroke,
                            'stroke-width': 1.5,
                        }),
                    );
                    g.appendChild(
                        svg('circle', {
                            cx: x + 6,
                            cy: y + dy + 3,
                            r: 1.2,
                            fill: '#43a047',
                            stroke: 'none',
                        }),
                    );
                });
                break;
            case 'speaker':
                g.appendChild(
                    svg('rect', {
                        x: x - 7,
                        y: y - 10,
                        width: 14,
                        height: 20,
                        rx: 7,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('circle', {
                        cx: x,
                        cy: y - 3.5,
                        r: 2.6,
                        fill: plate.fill,
                        stroke: plate.stroke,
                        'stroke-width': 1,
                    }),
                );
                g.appendChild(
                    svg('circle', { cx: x, cy: y + 4.5, r: 1.5, fill: '#78909c', stroke: 'none' }),
                );
                break;
            case 'camera':
                g.appendChild(
                    svg('rect', {
                        x: x - 9,
                        y: y - 6,
                        width: 18,
                        height: 12,
                        rx: 2.5,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('circle', {
                        cx: x + 1,
                        cy: y,
                        r: 3.4,
                        fill: 'none',
                        stroke: '#546e7a',
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('path', {
                        d:
                            'M ' +
                            (x - 9) +
                            ' ' +
                            (y - 6) +
                            ' L ' +
                            (x - 5) +
                            ' ' +
                            (y - 10) +
                            ' L ' +
                            (x + 1) +
                            ' ' +
                            (y - 10) +
                            ' L ' +
                            (x + 4) +
                            ' ' +
                            (y - 6),
                        fill: plate.fill,
                        stroke: plate.stroke,
                        'stroke-width': 1,
                    }),
                );
                break;
            case 'printer':
                g.appendChild(
                    svg('rect', {
                        x: x - 10,
                        y: y - 2,
                        width: 20,
                        height: 9,
                        rx: 2,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('rect', {
                        x: x - 6,
                        y: y - 9,
                        width: 12,
                        height: 7,
                        rx: 1,
                        fill: '#fff',
                        stroke: '#78909c',
                        'stroke-width': 1.3,
                    }),
                );
                g.appendChild(
                    svg('rect', {
                        x: x - 6,
                        y: y + 5,
                        width: 12,
                        height: 6,
                        rx: 1,
                        fill: '#fff',
                        stroke: '#78909c',
                        'stroke-width': 1.3,
                    }),
                );
                break;
            case 'router':
                g.appendChild(
                    svg('rect', {
                        x: x - 10,
                        y: y - 3,
                        width: 20,
                        height: 8,
                        rx: 2,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                [-6, -2, 2, 6].forEach(function (dx) {
                    g.appendChild(
                        svg('circle', {
                            cx: x + dx,
                            cy: y + 1,
                            r: 1.2,
                            fill: '#78909c',
                            stroke: 'none',
                        }),
                    );
                });
                g.appendChild(
                    svg('line', {
                        x1: x - 4,
                        y1: y - 3,
                        x2: x - 7,
                        y2: y - 10,
                        stroke: box.stroke,
                        'stroke-width': 1.5,
                        'stroke-linecap': 'round',
                    }),
                );
                g.appendChild(
                    svg('line', {
                        x1: x + 4,
                        y1: y - 3,
                        x2: x + 7,
                        y2: y - 10,
                        stroke: box.stroke,
                        'stroke-width': 1.5,
                        'stroke-linecap': 'round',
                    }),
                );
                break;
            case 'wired':
                g.appendChild(
                    svg('rect', {
                        x: x - 8,
                        y: y - 6,
                        width: 16,
                        height: 12,
                        rx: 2,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                [-5, -1, 3, 7].forEach(function (dx) {
                    g.appendChild(
                        svg('rect', {
                            x: x + dx - 1.5,
                            y: y - 10,
                            width: 3,
                            height: 5,
                            rx: 1,
                            fill: plate.fill,
                            stroke: '#90a4ae',
                            'stroke-width': 0.8,
                        }),
                    );
                });
                break;
            case 'iot':
                g.appendChild(
                    svg('rect', {
                        x: x - 7,
                        y: y - 7,
                        width: 14,
                        height: 14,
                        rx: 2,
                        fill: box.fill,
                        stroke: box.stroke,
                        'stroke-width': 1.6,
                    }),
                );
                g.appendChild(
                    svg('rect', {
                        x: x - 3,
                        y: y - 3,
                        width: 6,
                        height: 6,
                        rx: 1,
                        fill: plate.fill,
                        stroke: plate.stroke,
                        'stroke-width': 1,
                    }),
                );
                [-4, 0, 4].forEach(function (d) {
                    g.appendChild(
                        svg('line', {
                            x1: x + d,
                            y1: y - 10.5,
                            x2: x + d,
                            y2: y - 7,
                            stroke: box.stroke,
                            'stroke-width': 1.3,
                        }),
                    );
                    g.appendChild(
                        svg('line', {
                            x1: x + d,
                            y1: y + 7,
                            x2: x + d,
                            y2: y + 10.5,
                            stroke: box.stroke,
                            'stroke-width': 1.3,
                        }),
                    );
                    g.appendChild(
                        svg('line', {
                            x1: x - 10.5,
                            y1: y + d,
                            x2: x - 7,
                            y2: y + d,
                            stroke: box.stroke,
                            'stroke-width': 1.3,
                        }),
                    );
                    g.appendChild(
                        svg('line', {
                            x1: x + 7,
                            y1: y + d,
                            x2: x + 10.5,
                            y2: y + d,
                            stroke: box.stroke,
                            'stroke-width': 1.3,
                        }),
                    );
                });
                break;
            default:
                g.appendChild(
                    svg('circle', {
                        cx: x,
                        cy: y - 4,
                        r: 3.2,
                        fill: plate.fill,
                        stroke: plate.stroke,
                        'stroke-width': 1.2,
                    }),
                );
                g.appendChild(
                    svg('path', {
                        d:
                            'M ' +
                            (x - 7) +
                            ' ' +
                            (y + 9) +
                            ' Q ' +
                            x +
                            ' ' +
                            (y - 1) +
                            ' ' +
                            (x + 7) +
                            ' ' +
                            (y + 9),
                        fill: 'none',
                        stroke: '#546e7a',
                        'stroke-width': 1.6,
                        'stroke-linecap': 'round',
                    }),
                );
        }
    },
    sigBars: function (g, x, y, rssi) {
        var lvl = rssi == null ? 0 : rssi >= -60 ? 3 : rssi >= -72 ? 2 : 1;
        var col = signalColor(rssi);
        [4, 7, 10].forEach(function (h, i) {
            g.appendChild(
                svg('rect', {
                    x: x + i * 5,
                    y: y - h,
                    width: 3.4,
                    height: h,
                    rx: 1.4,
                    fill: i < lvl ? col : '#dde3e8',
                    stroke: 'none',
                }),
            );
        });
    },
    pencilButton: function (g, x, y, n) {
        var self = this;
        var pg = svg('g', { class: 'wr-pencil' });
        pg.appendChild(
            svg('rect', {
                x: x - 6.5,
                y: y - 6.5,
                width: 13,
                height: 13,
                rx: 2,
                fill: '#fff',
                stroke: '#b0bec5',
                'stroke-width': 1.2,
            }),
        );
        pg.appendChild(
            svg('line', {
                x1: x - 2,
                y1: y + 2,
                x2: x + 1.6,
                y2: y - 1.6,
                stroke: '#546e7a',
                'stroke-width': 1.8,
                'stroke-linecap': 'round',
            }),
        );
        pg.appendChild(
            svg('path', {
                d:
                    'M ' +
                    (x - 2.8) +
                    ' ' +
                    (y + 2.8) +
                    ' L ' +
                    (x - 2.3) +
                    ' ' +
                    (y + 1.1) +
                    ' L ' +
                    (x - 1.1) +
                    ' ' +
                    (y + 2.3) +
                    ' Z',
                fill: '#546e7a',
                stroke: 'none',
            }),
        );
        pg.appendChild(svg('title', {}, _('Rename')));
        pg.addEventListener('click', function (ev) {
            ev.stopPropagation();
            self.openRename(n);
        });
        g.appendChild(pg);
    },
    toggleButton: function (g, x, y, apId, count) {
        var self = this;
        var isCollapsed = !!self.collapsed[apId];
        var tg = svg('g', { class: 'wr-toggle', style: 'cursor:pointer' });
        tg.appendChild(
            svg('circle', {
                cx: x,
                cy: y,
                r: 7,
                fill: '#fff',
                stroke: '#b0bec5',
                'stroke-width': 1.2,
            }),
        );
        if (isCollapsed) {
            tg.appendChild(
                svg('line', {
                    x1: x - 3,
                    y1: y,
                    x2: x + 3,
                    y2: y,
                    stroke: '#546e7a',
                    'stroke-width': 1.8,
                    'stroke-linecap': 'round',
                }),
            );
            tg.appendChild(
                svg('line', {
                    x1: x,
                    y1: y - 3,
                    x2: x,
                    y2: y + 3,
                    stroke: '#546e7a',
                    'stroke-width': 1.8,
                    'stroke-linecap': 'round',
                }),
            );
            tg.appendChild(
                svg('circle', {
                    cx: x + 7,
                    cy: y - 7,
                    r: 6.5,
                    fill: '#1565c0',
                    stroke: '#fff',
                    'stroke-width': 1.2,
                }),
            );
            tg.appendChild(
                svg(
                    'text',
                    {
                        x: x + 7,
                        y: y - 4.5,
                        style: 'fill:#fff;stroke:none;font-size:8px;font-weight:700;text-anchor:middle',
                    },
                    String(count),
                ),
            );
        } else {
            tg.appendChild(
                svg('line', {
                    x1: x - 3,
                    y1: y,
                    x2: x + 3,
                    y2: y,
                    stroke: '#546e7a',
                    'stroke-width': 1.8,
                    'stroke-linecap': 'round',
                }),
            );
        }
        tg.appendChild(svg('title', {}, isCollapsed ? _('Expand') : _('Collapse')));
        tg.addEventListener('click', function (ev) {
            ev.stopPropagation();
            self.collapsed[apId] = !self.collapsed[apId];
            self.redraw();
        });
        g.appendChild(tg);
    },
    // ---- Full redraw of the topology SVG + status strip + log ----
    redraw: function () {
        var box = document.getElementById('wr-topo');
        if (!box || this.modalOpen) return;
        if (!this.topo) {
            dom.content(
                box,
                E(
                    'div',
                    { class: 'wr-empty' },
                    _('Cannot reach wifiroamd. Make sure the service is running.'),
                ),
            );
            return;
        }
        var lay = this.layout();
        var pos = lay.pos;
        var self = this;
        var th = THEMES[this.themeId] || THEMES.map;
        THEME_IDS.forEach(function (id) {
            box.classList.toggle('wr-theme-' + id, THEMES[self.themeId] && id === self.themeId);
        });
        var root = svg('svg', {
            viewBox: '0 0 ' + lay.W + ' ' + lay.H,
            preserveAspectRatio: 'xMidYMin meet',
            width: '100%',
        });
        root.style.height = 'auto';
        var defs = svg('defs');
        defs.innerHTML =
            '<linearGradient id="wrGAp" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' +
            th.apG[0] +
            '"/>' +
            '<stop offset="100%" stop-color="' +
            th.apG[1] +
            '"/>' +
            '</linearGradient>' +
            '<linearGradient id="wrGCap" x1="0" y1="0" x2="0" y2="1">' +
            '<stop offset="0%" stop-color="' +
            th.capG[0] +
            '"/>' +
            '<stop offset="100%" stop-color="' +
            th.capG[1] +
            '"/>' +
            '</linearGradient>' +
            '<filter id="wrShadow" x="-50%" y="-50%" width="200%" height="200%">' +
            '<feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#1c3b5a" flood-opacity="0.16"/>' +
            '</filter>';
        root.appendChild(defs);
        function label(g, x, y, str, cls, maxW) {
            if (str == null) return;
            str = String(str);
            var t = svg('text', { x: x, y: y, class: cls }, fitText(str, maxW));
            t.appendChild(svg('title', {}, str));
            g.appendChild(t);
        }
        if (lay.root) {
            var sideLvl = { '-1': 0, 1: 0 };
            lay.saps.forEach(function (a) {
                var rp = pos[lay.root.id],
                    sp = pos[a.id];
                if (!rp || !sp) return;
                var dir = sp.x < rp.x ? -1 : 1;
                var lvl = sideLvl[dir]++;
                var startY = rp.y + th.linkTop;
                var bhY = startY + 8 + lvl * 14;
                var d =
                    'M ' +
                    rp.x +
                    ' ' +
                    startY +
                    ' L ' +
                    rp.x +
                    ' ' +
                    bhY +
                    ' L ' +
                    sp.x +
                    ' ' +
                    bhY +
                    ' L ' +
                    sp.x +
                    ' ' +
                    (sp.y - (th.ap === 'card' ? 48 : 24));
                var wireless = a.uplink && a.uplink.type === 'wireless';
                root.appendChild(
                    svg('path', {
                        d: d,
                        class: 'wr-link wr-aplink' + (wireless ? ' wr-wireless' : ''),
                        fill: 'none',
                    }),
                );
            });
            Object.keys(lay.byParent).forEach(function (pid) {
                if (self.collapsed[pid]) return;
                var pp = pos[pid];
                if (!pp) return;
                var kids = lay.byParent[pid].filter(function (c) {
                    return pos[c.id];
                });
                if (!kids.length) return;
                var linkTop = pp.y + th.linkTop,
                    linkBot = LAY.clY0 - 18;
                var busY = Math.round(linkTop + (linkBot - linkTop) * 0.35);
                var anyWired = kids.some(function (c) {
                    return !(c.conn && c.conn.type === 'wifi');
                });
                root.appendChild(
                    svg('line', {
                        x1: pp.x,
                        y1: linkTop,
                        x2: pp.x,
                        y2: busY,
                        class: 'wr-link wr-clink' + (anyWired ? '' : ' wr-wireless'),
                    }),
                );
                var rows = {},
                    metas = [];
                kids.forEach(function (c) {
                    var row = Math.round((pos[c.id].y - LAY.clY0) / LAY.clStep);
                    (rows[row] = rows[row] || []).push(c);
                });
                Object.keys(rows)
                    .map(Number)
                    .sort(function (a, b) {
                        return a - b;
                    })
                    .forEach(function (row) {
                        var wifiXs = [],
                            wiredXs = [];
                        rows[row].forEach(function (c) {
                            if (c.conn && c.conn.type === 'wifi') wifiXs.push(pos[c.id].x);
                            else wiredXs.push(pos[c.id].x);
                        });
                        metas.push({
                            list: rows[row],
                            wifiXs: wifiXs,
                            wiredXs: wiredXs,
                            y: row === 0 ? busY : Math.round(LAY.clY0 + row * LAY.clStep - 36),
                        });
                    });
                for (var i = 1; i < metas.length; i++) {
                    var above = metas[i - 1],
                        cur = metas[i];
                    var same = cur.wifiXs.length ? above.wifiXs : above.wiredXs;
                    if (same.length < 2) same = above.wifiXs.concat(above.wiredXs);
                    same = same.slice().sort(function (a, b) {
                        return a - b;
                    });
                    cur.feedX = pp.x;
                    var bestD = Infinity;
                    for (var j = 0; j + 1 < same.length; j++) {
                        var mid = (same[j] + same[j + 1]) / 2;
                        var d = Math.abs(mid - pp.x);
                        if (d < bestD) {
                            bestD = d;
                            cur.feedX = mid;
                        }
                    }
                }
                metas.forEach(function (m, mi) {
                    if (m.feedX != null) {
                        root.appendChild(
                            svg('line', {
                                x1: m.feedX,
                                y1: metas[mi - 1].y,
                                x2: m.feedX,
                                y2: m.y,
                                class: 'wr-link wr-clink' + (anyWired ? '' : ' wr-wireless'),
                            }),
                        );
                    }
                    if (m.wifiXs.length && m.wiredXs.length) {
                        var wMin = Math.min.apply(null, m.wifiXs);
                        var eMax = Math.max.apply(null, m.wiredXs);
                        if (m.feedX != null) {
                            if (m.feedX <= pp.x) wMin = Math.min(wMin, m.feedX);
                            else eMax = Math.max(eMax, m.feedX);
                        }
                        root.appendChild(
                            svg('line', {
                                x1: wMin,
                                y1: m.y,
                                x2: pp.x,
                                y2: m.y,
                                class: 'wr-link wr-clink wr-wireless',
                            }),
                        );
                        root.appendChild(
                            svg('line', {
                                x1: pp.x,
                                y1: m.y,
                                x2: eMax,
                                y2: m.y,
                                class: 'wr-link wr-clink',
                            }),
                        );
                    } else {
                        var allXs = m.wifiXs.concat(m.wiredXs).concat([pp.x]);
                        if (m.feedX != null) allXs.push(m.feedX);
                        var bx1 = Math.min.apply(null, allXs);
                        var bx2 = Math.max.apply(null, allXs);
                        if (bx2 - bx1 > 0.5) {
                            root.appendChild(
                                svg('line', {
                                    x1: bx1,
                                    y1: m.y,
                                    x2: bx2,
                                    y2: m.y,
                                    class:
                                        'wr-link wr-clink' +
                                        (m.wifiXs.length ? ' wr-wireless' : ''),
                                }),
                            );
                        }
                    }
                    m.list.forEach(function (c) {
                        var cp = pos[c.id];
                        var cls = 'wr-link wr-clink';
                        if (c.conn && c.conn.type === 'wifi') {
                            cls += ' wr-wireless';
                            if (c.conn.rssi != null) cls += ' ' + wr.rssiClass(c.conn.rssi);
                        }
                        root.appendChild(
                            svg('line', { x1: cp.x, y1: m.y, x2: cp.x, y2: cp.y - 18, class: cls }),
                        );
                    });
                });
            });
        }
        function apNode(a) {
            var p = pos[a.id];
            if (!p) return null;
            var g = svg('g', { class: 'wr-node wr-ap', 'data-id': a.id });
            var isCap = a.role === 'cap';
            var accent = isCap ? th.capStroke : th.apStroke;
            var kids = (lay.byParent[a.id] || []).length;
            if (th.ap === 'card') {
                var w = 138,
                    h = 96;
                g.appendChild(
                    svg('rect', {
                        class: 'wr-ap-box',
                        x: p.x - w / 2,
                        y: p.y - h / 2,
                        width: w,
                        height: h,
                        rx: 8,
                        fill: isCap ? 'url(#wrGCap)' : 'url(#wrGAp)',
                        stroke: accent,
                        'stroke-width': 1.4,
                    }),
                );
                self.routerArt(g, p.x, p.y - 25, 0.78, a, isCap, accent, false);
                g.appendChild(
                    svg('circle', {
                        cx: p.x - w / 2 + 14,
                        cy: p.y - h / 2 + 14,
                        r: 8,
                        fill: accent,
                        stroke: '#fff',
                        'stroke-width': 1.5,
                    }),
                );
                g.appendChild(
                    svg(
                        'text',
                        {
                            x: p.x - w / 2 + 14,
                            y: p.y - h / 2 + 17.5,
                            style: 'fill:#fff;stroke:none;font-size:9px;font-weight:700',
                        },
                        isCap ? 'C' : 'S',
                    ),
                );
                label(g, p.x, p.y + 9, a.name || a.mac || a.id, 'wr-label', w - 26);
                if (a.ip) label(g, p.x, p.y + 26, a.ip, 'wr-sub', w - 26);
                self.pencilButton(g, p.x + w / 2 - 13, p.y - h / 2 + 13, a);
                if (kids > 0) self.toggleButton(g, p.x + w / 2 - 13, p.y + h / 2 - 13, a.id, kids);
            } else {
                self.apIcon(g, p, a, accent);
                label(g, p.x, p.y + 44, a.name || a.mac || a.id, 'wr-label', 168);
                if (a.ip) label(g, p.x, p.y + 60, a.ip, 'wr-sub', 168);
                self.pencilButton(g, p.x + 24, p.y - 24, a);
                if (kids > 0) self.toggleButton(g, p.x, p.y + 74, a.id, kids);
            }
            g.addEventListener('click', function () {
                self.openDetail(a);
            });
            return g;
        }
        function clientNode(c) {
            var p = pos[c.id];
            if (!p) return null;
            var g = svg('g', { class: 'wr-node wr-client', 'data-id': c.id });
            var wifi = c.conn && c.conn.type === 'wifi';
            var stroke = wifi ? signalColor(c.conn.rssi) : '#cfd8dc';
            var badge = th.client === 'badge';
            var vx, vy, vr, vfs, textY, subY, pn;
            if (badge) {
                g.appendChild(
                    svg('circle', {
                        class: 'wr-cl-card' + (wifi ? '' : ' wr-wired'),
                        cx: p.x,
                        cy: p.y,
                        r: 17,
                        fill: '#ffffff',
                        stroke: stroke,
                        'stroke-width': 1.8,
                    }),
                );
                self.glyph(g, p.x, p.y, deviceKind(c));
                if (wifi) self.sigBars(g, p.x + 21, p.y - 8, c.conn.rssi);
                vx = p.x + 12;
                vy = p.y + 12;
                vr = 6.5;
                vfs = 7;
                textY = p.y + 33;
                subY = p.y + 47;
                pn = 14;
            } else {
                g.appendChild(
                    svg('rect', {
                        class: 'wr-cl-card' + (wifi ? '' : ' wr-wired'),
                        x: p.x - 17,
                        y: p.y - 17,
                        width: 34,
                        height: 34,
                        rx: 5,
                        fill: '#ffffff',
                        stroke: stroke,
                        'stroke-width': 2,
                        filter: 'url(#wrShadow)',
                    }),
                );
                self.glyph(g, p.x, p.y, deviceKind(c));
                if (wifi) self.sigBars(g, p.x + 24, p.y - 9, c.conn.rssi);
                vx = p.x + 15;
                vy = p.y + 14;
                vr = 7.5;
                vfs = 8;
                textY = p.y + 35;
                subY = p.y + 49;
                pn = 17;
            }
            var v = wr.vendorOf(c.mac, (c.hostname || '') + ' ' + (c.name || ''));
            if (v) {
                g.appendChild(
                    svg('circle', {
                        cx: vx,
                        cy: vy,
                        r: vr,
                        fill: v.color,
                        stroke: '#fff',
                        'stroke-width': 1.2,
                    }),
                );
                if (v.logo) {
                    g.appendChild(
                        svg('path', {
                            d: v.logo,
                            fill: '#fff',
                            transform:
                                'translate(' + (vx - 4.5) + ' ' + (vy - 4.5) + ') scale(0.375)',
                        }),
                    );
                } else {
                    g.appendChild(
                        svg(
                            'text',
                            {
                                x: vx,
                                y: vy + 2.5,
                                style:
                                    'fill:#fff;stroke:none;font-size:' +
                                    vfs +
                                    'px;font-weight:700;text-anchor:middle',
                            },
                            v.initial,
                        ),
                    );
                }
            }
            label(g, p.x, textY, c.name || c.mac || c.id, 'wr-label', 100);
            var sub = wifi ? wr.rssiText(c.conn.rssi) : (c.conn && c.conn.port) || c.ip || '';
            if (sub) label(g, p.x, subY, sub, 'wr-sub', 104);
            self.pencilButton(g, p.x + pn, p.y - pn, c);
            g.addEventListener('click', function () {
                self.openDetail(c);
            });
            return g;
        }
        if (lay.root) {
            var rn = apNode(lay.root);
            if (rn) root.appendChild(rn);
            lay.saps.forEach(function (a) {
                var n = apNode(a);
                if (n) root.appendChild(n);
            });
            lay.clients.forEach(function (c) {
                if (self.collapsed[c.parent]) return;
                var n = clientNode(c);
                if (n) root.appendChild(n);
            });
        }
        dom.content(box, root);
        var sb = document.getElementById('wr-status');
        if (sb && this.status) dom.content(sb, wr.statusBar(this.status));
        this.renderLog();
    },
    clearLogFilter: function () {
        this.logFilter = { type: '', name: '', mac: '', info: '' };
        ['wr-flt-name', 'wr-flt-mac', 'wr-flt-info'].forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var sel = document.getElementById('wr-flt-type');
        if (sel) sel.value = '';
        this.renderLog();
    },
    // ---- Roaming event log (with filters) ----
    renderLog: function () {
        var box = document.getElementById('wr-log');
        if (!box) return;
        var f = this.logFilter || (this.logFilter = { type: '', name: '', mac: '', info: '' });
        var types = [];
        (this.logs || []).forEach(function (ev) {
            var label = EVENT_TEXT[ev.type] || ev.type;
            if (label && types.indexOf(label) < 0) types.push(label);
        });
        var sel = document.getElementById('wr-flt-type');
        if (sel && types.join('|') !== this._logTypeSig) {
            this._logTypeSig = types.join('|');
            dom.content(
                sel,
                [E('option', { value: '' }, '全部类型')].concat(
                    types.map(function (t) {
                        return E('option', { value: t }, t);
                    }),
                ),
            );
            sel.value = f.type;
        }
        var lc = function (s) {
            return (s || '').toLowerCase();
        };
        var list = (this.logs || []).filter(function (ev) {
            var tlabel = EVENT_TEXT[ev.type] || ev.type || '';
            if (f.type && tlabel !== f.type) return false;
            if (f.name && lc(ev.name).indexOf(lc(f.name)) < 0) return false;
            if (f.mac && lc(ev.mac).indexOf(lc(f.mac)) < 0) return false;
            if (f.info && lc(ev.info).indexOf(lc(f.info)) < 0) return false;
            return true;
        });
        var rows = list
            .slice()
            .sort(function (a, b) {
                return (b.ts || 0) - (a.ts || 0);
            })
            .map(function (ev) {
                var t = wr.fmtTime(ev.ts);
                return E('tr', {}, [
                    E('td', { style: 'white-space:nowrap;color:#90a4ae' }, t),
                    E('td', { style: 'white-space:nowrap' }, EVENT_TEXT[ev.type] || ev.type || '-'),
                    E(
                        'td',
                        {
                            style: 'white-space:nowrap;max-width:12em;overflow:hidden;text-overflow:ellipsis',
                            title: ev.name || '',
                        },
                        ev.name || '-',
                    ),
                    E('td', { style: 'font-family:monospace;font-size:12px' }, ev.mac || '-'),
                    E('td', {}, ev.info || '-'),
                ]);
            });
        if (!rows.length)
            rows = [
                E(
                    'tr',
                    { class: 'tr placeholder' },
                    E(
                        'td',
                        { colspan: 5 },
                        (this.logs || []).length ? '没有匹配过滤条件的事件' : _('No events yet'),
                    ),
                ),
            ];
        dom.content(
            box,
            E('div', {}, [
                E(
                    'div',
                    { class: 'wr-log-count' },
                    '匹配 ' + list.length + ' / 共 ' + (this.logs || []).length + ' 条',
                ),
                E(
                    'table',
                    { class: 'table' },
                    [
                        E('tr', { class: 'tr table-titles' }, [
                            E('th', {}, _('Time')),
                            E('th', {}, _('Event')),
                            E('th', {}, _('Device Name')),
                            E('th', {}, _('MAC')),
                            E('th', {}, _('Detail')),
                        ]),
                    ].concat(rows),
                ),
            ]),
        );
    },
    openRename: function (n) {
        var self = this;
        this.modalOpen = true;
        var input = E('input', {
            type: 'text',
            class: 'cbi-input-text',
            value: n.custom_name || '',
            placeholder: _('Custom Name'),
            style: 'width:100%',
        });
        var body = E('div', {}, [
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, _('Custom Name')),
                input,
                E('div', { class: 'wr-hint' }, _('Leave empty to use the detected name.')),
            ]),
            E('div', { class: 'wr-hint' }, n.mac || ''),
        ]);
        var cancel = E(
            'button',
            {
                class: 'btn',
                click: function () {
                    self.modalOpen = false;
                    ui.hideModal();
                },
            },
            _('Cancel'),
        );
        var save = E(
            'button',
            {
                class: 'btn cbi-button-positive',
                click: function () {
                    return wr
                        .call('set_alias', { mac: clientKey(n), name: input.value.trim() })
                        .then(function (res) {
                            self.modalOpen = false;
                            ui.hideModal();
                            if (res && res.ok) {
                                wr.notify('success', _('Name saved'));
                                self.fetch();
                            } else {
                                wr.notify(
                                    'danger',
                                    _('Failed') + ': ' + ((res && res.error) || 'unknown'),
                                );
                            }
                        })
                        .catch(function () {
                            wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                        });
                },
            },
            _('Save Name'),
        );
        ui.showModal(_('Rename') + ' - ' + (n.name || n.mac || n.id), [
            body,
            E('div', { class: 'right' }, [cancel, ' ', save]),
        ]);
        window.setTimeout(function () {
            input.focus();
            input.select();
        }, 50);
        var dlg = document.querySelector('.modal');
        if (dlg)
            dlg.addEventListener('hide', function () {
                self.modalOpen = false;
            });
    },
    openDonate: function () {
        var self = this;
        this.modalOpen = true;
        ui.showModal('用得爽，打个赏', [
            E('div', { class: 'wr-donate-body' }, [
                E('img', { src: L.resource('wifiroam/donate-qr.png'), alt: 'donate qr' }),
                E('p', {}, '感谢您的认可，打赏用户有任何需求可发送至邮箱 475662846@qq.com'),
            ]),
            E('div', { class: 'right' }, [
                E(
                    'button',
                    {
                        class: 'btn',
                        click: function () {
                            self.modalOpen = false;
                            ui.hideModal();
                        },
                    },
                    '关闭',
                ),
            ]),
        ]);
        var dlg = document.querySelector('.modal');
        if (dlg)
            dlg.addEventListener('hide', function () {
                self.modalOpen = false;
            });
    },
    dayStr: function (offset) {
        var base =
            this.appctl && this.appctl.day ? new Date(this.appctl.day + 'T00:00:00') : new Date();
        var d = new Date(base.getTime() - offset * 86400000);
        var p = function (x) {
            return (x < 10 ? '0' : '') + x;
        };
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    },
    statsBox: function (n) {
        var self = this;
        var mac = clientKey(n);
        var box = E('div', { class: 'wr-stats' });
        function onlineDays() {
            var ac = self.appctl;
            return (ac && ac.online && ac.online[mac]) || {};
        }
        function periodSec() {
            var ds = onlineDays(),
                p = self._statsPeriod || 'today';
            if (p === 'yesterday') return ds[self.dayStr(1)] || 0;
            if (p === 'week') {
                var s = 0;
                for (var i = 0; i < 7; i++) s += ds[self.dayStr(i)] || 0;
                return s;
            }
            return ds[self.dayStr(0)] || 0;
        }
        function periodBytes() {
            var ac = self.appctl;
            var ds = (ac && ac.ndata && ac.ndata[mac]) || {};
            var p = self._statsPeriod || 'today';
            if (p === 'yesterday') return ds[self.dayStr(1)] || 0;
            if (p === 'week') {
                var s = 0;
                for (var i = 0; i < 7; i++) s += ds[self.dayStr(i)] || 0;
                return s;
            }
            return ds[self.dayStr(0)] || 0;
        }
        function render() {
            var p = self._statsPeriod || 'today';
            var tabs = E(
                'div',
                { class: 'wr-tabs' },
                [
                    ['yesterday', _('Yesterday')],
                    ['today', _('Today')],
                    ['week', _('Last 7 days')],
                ].map(function (t) {
                    return E(
                        'button',
                        {
                            class: 'wr-tab' + (p === t[0] ? ' active' : ''),
                            click: function () {
                                self._statsPeriod = t[0];
                                render();
                                if (self._appRedraw) self._appRedraw();
                            },
                        },
                        t[1],
                    );
                }),
            );
            var ds = onlineDays();
            var chart = svg('svg', { viewBox: '0 0 320 96', class: 'wr-chart' });
            [6, 12, 18, 24].forEach(function (h) {
                var y = 76 - (h * 70) / 24;
                chart.appendChild(
                    svg('line', {
                        x1: 34,
                        y1: y,
                        x2: 320,
                        y2: y,
                        stroke: '#eceff1',
                        'stroke-width': 1,
                    }),
                );
                chart.appendChild(
                    svg('text', { x: 32, y: y + 3, 'text-anchor': 'end' }, _('%dh').format(h)),
                );
            });
            var slot = (320 - 34) / 7;
            for (var i = 6; i >= 0; i--) {
                var key = self.dayStr(i);
                var sec = ds[key] || 0;
                var h = Math.max(sec > 0 ? 1.5 : 0, (sec * 70) / 86400);
                var cx = 34 + (6 - i) * slot + slot / 2;
                var bar = svg('rect', {
                    x: cx - 11,
                    y: 76 - h,
                    width: 22,
                    height: h,
                    rx: 2,
                    fill: i === 0 ? '#1e88e5' : '#64b5f6',
                });
                bar.appendChild(svg('title', {}, key + ' ' + (sec > 0 ? wr.fmtDur(sec) : '0')));
                chart.appendChild(bar);
                chart.appendChild(
                    svg(
                        'text',
                        { x: cx, y: 90, 'text-anchor': 'middle' },
                        key.slice(5).replace('-', '.'),
                    ),
                );
            }
            dom.content(box, [
                E('div', { class: 'wr-stats-head' }, [E('b', {}, _('Usage stats')), tabs]),
                E('div', { class: 'wr-dev-online wr-stats-online' }, [
                    E('div', {}, [
                        E('div', { class: 'wr-cap' }, _('Online time')),
                        E('div', { class: 'wr-big' }, wr.fmtDur(periodSec())),
                    ]),
                    E('div', {}, [
                        E('div', { class: 'wr-cap' }, _('Traffic')),
                        E('div', { class: 'wr-big' }, wr.fmtBytes(periodBytes())),
                    ]),
                ]),
                chart,
            ]);
        }
        self._statsRedraw = render;
        render();
        return box;
    },
    refreshAppctl: function (force) {
        var seq = ++this.appctlReq;
        return safeCall('appctl_status').then(
            L.bind(function (res) {
                if (res && seq === this.appctlReq && (force || !this.appctlSaving))
                    this.appctl = res;
                return res;
            }, this),
        );
    },
    appctlBox: function (n) {
        var self = this;
        var box = E('div', { class: 'wr-appctl' });
        function render(force) {
            if (!force && document.activeElement && box.contains(document.activeElement)) return;
            var ac = self.appctl;
            var mac = clientKey(n);
            var dev = (ac && ac.devices && ac.devices[mac]) || null;
            var blocks = (dev && dev.block) || [];
            var stats = (ac && ac.stats && ac.stats[mac]) || {};
            var now = Math.floor(Date.now() / 1000);
            var period = self._statsPeriod || 'today';
            function pDur(st) {
                var ds = st.days || {};
                if (period === 'yesterday') return ds[self.dayStr(1)] || 0;
                if (period === 'week') {
                    var s = 0;
                    Object.keys(ds).forEach(function (k) {
                        s += ds[k] || 0;
                    });
                    return s;
                }
                return st.today || ds[self.dayStr(0)] || 0;
            }
            function pBytes(st) {
                var ds = st.bdays || {};
                if (period === 'yesterday') return ds[self.dayStr(1)] || 0;
                if (period === 'week') {
                    var s = 0;
                    Object.keys(ds).forEach(function (k) {
                        s += ds[k] || 0;
                    });
                    return s;
                }
                return st.btoday || ds[self.dayStr(0)] || 0;
            }
            var enableCb = null;
            if (ac && ac.ok) {
                enableCb = E('input', {
                    type: 'checkbox',
                    class: 'wr-switch-input',
                    change: function (ev) {
                        var on = ev.target.checked;
                        ev.target.disabled = true;
                        self.appctlSaving++;
                        self.appctlReq++;
                        function finish() {
                            return self.refreshAppctl(true).then(function () {
                                self.appctlSaving--;
                                render(true);
                            });
                        }
                        wr.call('set_appctl', { enabled: on, enhanced: ac.enhanced === true })
                            .then(function (res) {
                                if (res && res.ok)
                                    wr.notify('success', on ? _('Enabled') : _('Disabled'));
                                else
                                    wr.notify(
                                        'danger',
                                        _('Failed') + ': ' + ((res && res.error) || 'unknown'),
                                    );
                                return finish();
                            })
                            .catch(function () {
                                wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                                return finish();
                            });
                    },
                });
                enableCb.checked = !!ac.enabled;
            }
            var head = E('div', { class: 'wr-appctl-head' }, [
                E('b', {}, _('App Usage & Access Control')),
                enableCb
                    ? E('label', { class: 'wr-appctl-switch' }, [enableCb, ' ' + _('Enable')])
                    : null,
            ]);
            if (!ac || !ac.ok) {
                dom.content(box, [
                    head,
                    E(
                        'div',
                        { class: 'wr-muted', style: 'margin-top:0.5em' },
                        ac && ac.error === 'not_cap'
                            ? _('Configure app control on the main AP')
                            : _('Cannot reach wifiroamd'),
                    ),
                ]);
                return;
            }
            var list = E('div', { class: 'wr-app-rows' });
            var shown = (ac.apps || []).filter(function (a) {
                return pDur(stats[a.id] || {}) > 0;
            });
            var blockedOnly = (ac.apps || []).filter(function (a) {
                return blocks.indexOf(a.id) >= 0 && pDur(stats[a.id] || {}) <= 0;
            });
            shown.sort(function (a, b) {
                var diff = pDur(stats[b.id] || {}) - pDur(stats[a.id] || {});
                return diff || a.name.localeCompare(b.name);
            });
            function policySelect(a, blocked) {
                if (!ac.enabled) return E('span', { class: 'wr-muted' }, '-');
                var ctl = E(
                    'select',
                    {
                        class: 'cbi-input-select wr-app-sel',
                        change: function (ev) {
                            var action = ev.target.value;
                            ev.target.disabled = true;
                            self.appctlSaving++;
                            self.appctlReq++;
                            function finish() {
                                return self.refreshAppctl(true).then(function () {
                                    self.appctlSaving--;
                                    render(true);
                                });
                            }
                            wr.call('set_app_policy', { mac: mac, app: a.id, action: action })
                                .then(function (res) {
                                    if (res && res.ok) wr.notify('success', _('Saved'));
                                    else
                                        wr.notify(
                                            'danger',
                                            _('Failed') + ': ' + ((res && res.error) || 'unknown'),
                                        );
                                    return finish();
                                })
                                .catch(function () {
                                    wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                                    return finish();
                                });
                        },
                    },
                    [
                        E('option', { value: 'allow' }, _('Allowed')),
                        E('option', { value: 'block' }, _('Blocked')),
                    ],
                );
                ctl.value = blocked ? 'block' : 'allow';
                return ctl;
            }
            if (!shown.length)
                list.appendChild(
                    E(
                        'div',
                        { class: 'wr-muted', style: 'padding:0.5em 0' },
                        _('No app usage yet'),
                    ),
                );
            var identified = 0;
            var nd = (ac.ndata && ac.ndata[mac]) || {};
            var tot = 0;
            if (period === 'yesterday') tot = nd[self.dayStr(1)] || 0;
            else if (period === 'week') {
                Object.keys(nd).forEach(function (k) {
                    tot += nd[k] || 0;
                });
            } else tot = nd[self.dayStr(0)] || 0;
            var rawSum = 0;
            (ac.apps || []).forEach(function (a) {
                rawSum += pBytes(stats[a.id] || {});
            });
            var scale = rawSum > tot && rawSum > 0 ? tot / rawSum : 1;
            shown.forEach(function (a) {
                var st = stats[a.id] || {};
                var bytes = Math.round(pBytes(st) * scale);
                identified += bytes;
                var blocked = blocks.indexOf(a.id) >= 0;
                var live = st.last && now - st.last < 90;
                var ctl = policySelect(a, blocked);
                list.appendChild(
                    E('div', { class: 'wr-app-row' }, [
                        appCell(a.id, a.name, live),
                        E('div', { class: 'wr-app-dur' }, [
                            E('span', {}, wr.fmtDur(pDur(st))),
                            E('span', { class: 'wr-total' }, wr.fmtBytes(bytes)),
                        ]),
                        ctl,
                    ]),
                );
            });
            var other = tot - identified;
            if (other >= 1024) {
                list.appendChild(
                    E('div', { class: 'wr-app-row wr-app-other' }, [
                        E('div', { class: 'wr-app-cell' }, [
                            E('span', { class: 'wr-app-name' }, _('Other apps')),
                        ]),
                        E('div', { class: 'wr-app-dur' }, [
                            E('span', { class: 'wr-muted' }, '-'),
                            E('span', { class: 'wr-total' }, wr.fmtBytes(other)),
                        ]),
                        E('span', { class: 'wr-muted' }, '-'),
                    ]),
                );
            }
            var children = [head];
            if (!ac.enabled)
                children.push(
                    E(
                        'div',
                        { class: 'wr-muted', style: 'margin:0.4em 0' },
                        _('Turn on app control to collect usage and enforce rules'),
                    ),
                );
            children.push(list);
            if (blockedOnly.length) {
                var blockedList = E('div', { class: 'wr-app-rows wr-app-blocked-only' }, [
                    E(
                        'div',
                        { class: 'wr-appctl-tip' },
                        _('Blocked apps without usage in this period'),
                    ),
                ]);
                blockedOnly.forEach(function (a) {
                    blockedList.appendChild(
                        E('div', { class: 'wr-app-row' }, [
                            appCell(a.id, a.name, false),
                            E('span', { class: 'wr-muted' }, _('No usage')),
                            policySelect(a, true),
                        ]),
                    );
                });
                children.push(blockedList);
            }
            children.push(
                E(
                    'div',
                    { class: 'wr-appctl-tip' },
                    _('Identified by DNS lookups; encrypted DNS may bypass detection.'),
                ),
            );
            dom.content(box, children);
        }
        self._appRedraw = render;
        render();
        return box;
    },
    scheduleBox: function (n) {
        var mn = clientKey(n);
        var requestSeq = 0;
        var btn = E('button', { class: 'btn cbi-button-positive', disabled: true }, _('Save'));
        var ctl;
        function refresh() {
            var seq = ++requestSeq;
            return wr.safeCall('ban_list').then(function (res) {
                if (seq !== requestSeq) return;
                if (!res || !res.ok) {
                    ctl.setBusy(true);
                    btn.disabled = true;
                    ctl.setStatus('', _('Configure on the main AP'));
                    return;
                }
                ctl.setBusy(false);
                ctl.setEnabled(res.enabled !== false);
                var rule = null;
                (res.items || []).forEach(function (b) {
                    if (clientKey(b) === mn) rule = b;
                });
                if (rule) ctl.load(rule);
                else {
                    ctl.clear();
                    ctl.setStatus('', _('No rule yet'));
                }
                btn.disabled = false;
            });
        }
        ctl = wr.scheduleControls({
            mac: mn,
            loading: true,
            enabled: false,
            onEnable: function (on) {
                requestSeq++;
                ctl.setBusy(true);
                btn.disabled = true;
                wr.call('set_ban', { enabled: on })
                    .then(function (res) {
                        if (res && res.ok) wr.notify('success', on ? _('Enabled') : _('Disabled'));
                        else
                            wr.notify(
                                'danger',
                                _('Failed') + ': ' + ((res && res.error) || 'unknown'),
                            );
                        return refresh();
                    })
                    .catch(function () {
                        wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                        return refresh();
                    });
            },
        });
        btn.addEventListener('click', function () {
            if (!ctl.read().weekdays.length) {
                wr.notify('danger', _('Select at least one day'));
                return;
            }
            requestSeq++;
            wr.setBusy(btn, true, _('Saving...'));
            ctl.setBusy(true);
            ctl.save({ name: n.name || '' })
                .then(function (res) {
                    wr.setBusy(btn, false);
                    if (res && res.ok) wr.notify('success', _('Saved'));
                    else
                        wr.notify('danger', _('Failed') + ': ' + ((res && res.error) || 'unknown'));
                    return refresh();
                })
                .catch(function () {
                    wr.setBusy(btn, false);
                    wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                    return refresh();
                });
        });
        ctl.actions.appendChild(btn);
        ctl.setStatus('', _('Loading...'));
        refresh();
        return ctl;
    },
    // ---- Client detail dialog ----
    openDetail: function (n) {
        var self = this;
        this.modalOpen = true;
        this._statsPeriod = 'today';
        var rows = [];
        function row(k, v) {
            rows.push(E('tr', {}, [E('td', {}, k), E('td', {}, v == null || v === '' ? '-' : v)]));
        }
        if (n.type === 'ap') {
            row(_('Device Name'), n.name);
            row(_('Role'), wr.roleBadge(n.role));
            row(_('Model'), n.model);
            row(_('IP Address'), n.ip);
            row(_('MAC Address'), n.mac);
            row(_('Firmware'), n.firmware);
            row(_('Uptime'), wr.fmtUptime(n.uptime));
            row(
                _('Backhaul'),
                n.uplink
                    ? (n.uplink.type === 'wired' ? _('Wired') : _('Wireless')) +
                          (n.uplink.port ? ' (' + n.uplink.port + ')' : '')
                    : '-',
            );
            row(_('Clients'), '' + (n.clients || []).length);
        }
        var body, btns;
        if (n.type === 'ap') {
            body = E('div', {}, [E('table', { class: 'table wr-detail-table' }, rows)]);
            btns = [
                E(
                    'button',
                    {
                        class: 'btn',
                        click: function () {
                            self.modalOpen = false;
                            ui.hideModal();
                        },
                    },
                    _('Close'),
                ),
            ];
        } else {
            var now = Math.floor(Date.now() / 1000);
            var conn = n.conn || {};
            var wifi = conn.type === 'wifi';
            var vendor = wr.vendorOf(n.mac, (n.hostname || '') + ' ' + (n.name || ''));
            var upSpan = null,
                downSpan = null;
            if (wifi) {
                upSpan = E(
                    'span',
                    { class: 'wr-dev-up', title: _('Real-time send speed') },
                    '↑ ' + _('Send') + ' ' + wr.fmtRate(conn.rx_speed),
                );
                downSpan = E(
                    'span',
                    { class: 'wr-dev-down', title: _('Real-time receive speed') },
                    '↓ ' + _('Receive') + ' ' + wr.fmtRate(conn.tx_speed),
                );
                self._ratesRedraw = function () {
                    var cur = null;
                    ((self.topo && self.topo.nodes) || []).forEach(function (x) {
                        if (clientKey(x) === clientKey(n)) cur = x;
                    });
                    if (!cur || !cur.conn) return;
                    upSpan.textContent = '↑ ' + _('Send') + ' ' + wr.fmtRate(cur.conn.rx_speed);
                    downSpan.textContent =
                        '↓ ' + _('Receive') + ' ' + wr.fmtRate(cur.conn.tx_speed);
                };
            }
            var iconSvg = svg('svg', { width: 46, height: 34, viewBox: '0 0 46 34' });
            var ig = svg('g', {});
            iconSvg.appendChild(ig);
            this.glyph(ig, 23, 15, deviceKind(n));
            var nameInput = E('input', {
                type: 'text',
                class: 'cbi-input-text',
                value: n.custom_name || '',
                placeholder: _('Custom name'),
            });
            var nameEditRow = E('div', { class: 'wr-dev-nameedit', style: 'display:none' }, [
                nameInput,
                E(
                    'button',
                    {
                        class: 'btn cbi-button-positive',
                        click: function () {
                            return wr
                                .call('set_alias', { mac: clientKey(n), name: nameInput.value })
                                .then(function (res) {
                                    self.modalOpen = false;
                                    ui.hideModal();
                                    if (res && res.ok) {
                                        wr.notify('success', _('Name saved'));
                                        self.fetch();
                                    } else {
                                        wr.notify(
                                            'danger',
                                            _('Failed') + ': ' + ((res && res.error) || 'unknown'),
                                        );
                                    }
                                })
                                .catch(function () {
                                    wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                                });
                        },
                    },
                    _('Save'),
                ),
            ]);
            var infoLines = [
                E('div', {}, 'IPv4: ' + (n.ip || '-')),
                E('div', {}, 'MAC: ' + (n.mac || '-').toUpperCase()),
                E(
                    'div',
                    {},
                    _('Connection') +
                        ': ' +
                        wr.connText(n.conn) +
                        (wifi ? ' · ' + wr.rssiText(conn.rssi) : ''),
                ),
            ];
            if (vendor && vendor.name)
                infoLines.push(E('div', {}, _('Vendor') + ': ' + vendor.name));
            if (n.note) infoLines.push(E('div', {}, _('Note') + ': ' + n.note));
            if (n.grouped && (n.members || []).length > 1) {
                var memberLine = E('div', {}, _('Recognized MAC addresses') + ': ');
                n.members.forEach(function (m, i) {
                    if (i) memberLine.appendChild(document.createTextNode(' · '));
                    memberLine.appendChild(
                        E('span', { style: 'white-space:nowrap' }, [
                            m.toUpperCase() + ' ',
                            E(
                                'a',
                                {
                                    style: 'cursor:pointer;margin-left:0.3em',
                                    click: function () {
                                        if (
                                            !window.confirm(
                                                _('Separate this MAC address into its own device?'),
                                            )
                                        )
                                            return;
                                        wr.call('ungroup_device', { mac: m })
                                            .then(function (res) {
                                                if (res && res.ok) {
                                                    wr.notify('success', _('Device separated'));
                                                    self.modalOpen = false;
                                                    ui.hideModal();
                                                    self.fetch();
                                                } else
                                                    wr.notify(
                                                        'danger',
                                                        _('Failed') +
                                                            ': ' +
                                                            ((res && res.error) || 'unknown'),
                                                    );
                                            })
                                            .catch(function () {
                                                wr.notify(
                                                    'danger',
                                                    _('Failed') + ': ' + _('request rejected'),
                                                );
                                            });
                                    },
                                },
                                _('Split'),
                            ),
                        ]),
                    );
                });
                infoLines.push(memberLine);
            }
            if (n.isolated)
                infoLines.push(E('div', {}, _('Device grouping') + ': ' + _('Manually separated')));
            body = E('div', { class: 'wr-dev' }, [
                E('div', { class: 'wr-dev-head' }, [
                    iconSvg,
                    E('div', { class: 'wr-dev-title' }, n.name || n.mac),
                    E(
                        'a',
                        {
                            class: 'wr-dev-edit',
                            click: function () {
                                nameEditRow.style.display =
                                    nameEditRow.style.display === 'none' ? 'flex' : 'none';
                            },
                        },
                        _('Edit name'),
                    ),
                ]),
                E('div', { class: 'wr-dev-info' }, infoLines),
                nameEditRow,
                wifi ? E('div', { class: 'wr-dev-rates' }, [upSpan, downSpan]) : null,
                self.statsBox(n),
                self.scheduleBox(n).el,
                self.appctlBox(n),
            ]);
            btns = [
                E(
                    'button',
                    {
                        class: 'btn',
                        click: function () {
                            self.modalOpen = false;
                            ui.hideModal();
                        },
                    },
                    _('Close'),
                ),
            ];
        }
        ui.showModal(n.name || n.mac, [body, E('div', { class: 'right' }, btns)]);
        var dlg = document.querySelector('.modal');
        if (dlg)
            dlg.addEventListener('hide', function () {
                self.modalOpen = false;
                self._appRedraw = null;
                self._statsRedraw = null;
                self._ratesRedraw = null;
            });
    },
    // ---- Page entry point ----
    render: function (data) {
        this.topo = data[0];
        this.status = data[1];
        this.logs = (data[2] && data[2].events) || [];
        this.appctl = data[3] || null;
        this.logFilter = this.logFilter || { type: '', name: '', mac: '', info: '' };
        if (!this.themeId) {
            var saved = null;
            try {
                saved = window.localStorage.getItem('wr.topo.theme');
            } catch (e) {}
            this.themeId = THEMES[saved] ? saved : 'map';
        }
        poll.add(L.bind(this.fetch, this), 15);
        var hint = null;
        if (!this.topo)
            hint = E(
                'div',
                { class: 'alert-message warning' },
                _('Cannot reach wifiroamd. Make sure the service is running.'),
            );
        else if (this.topo.role === 'sap')
            hint = E(
                'div',
                { class: 'alert-message warning' },
                _('This device is a sub AP. Visit the main AP to see the full network topology.'),
            );
        var failed = null;
        var la = this.status && this.status.last_apply;
        if (la && la.results) {
            var bad = la.results.filter(function (r) {
                return r.ok === false;
            });
            if (bad.length)
                failed = E(
                    'div',
                    { class: 'alert-message warning' },
                    _('Some APs failed to apply roaming config') +
                        ': ' +
                        bad
                            .map(function (r) {
                                return r.name || r.ap;
                            })
                            .join(', '),
                );
        }
        function themeSel(vm) {
            var sel = E(
                'select',
                {
                    class: 'cbi-input-select wr-theme-sel',
                    change: function (ev) {
                        var v = ev.target.value;
                        if (!THEMES[v]) return;
                        vm.themeId = v;
                        try {
                            window.localStorage.setItem('wr.topo.theme', v);
                        } catch (e) {}
                        vm.redraw();
                    },
                },
                THEME_IDS.map(function (id) {
                    return E('option', { value: id }, _(THEMES[id].label));
                }),
            );
            sel.value = vm.themeId;
            return sel;
        }
        return E('div', {}, [
            wr.css(),
            E('h2', {}, [
                _('Network Management') + ' - ' + _('Network Topology'),
                E(
                    'a',
                    { class: 'wr-donate-btn', click: L.bind(this.openDonate, this) },
                    '用得爽，打个赏',
                ),
            ]),
            E('div', { id: 'wr-status' }, wr.statusBar(this.status || {})),
            hint,
            failed,
            E('div', { class: 'wr-toolbar' }, [
                E(
                    'button',
                    {
                        class: 'btn',
                        click: L.bind(function (ev) {
                            this.refresh(ev.currentTarget);
                        }, this),
                    },
                    _('Refresh'),
                ),
                E(
                    'span',
                    { id: 'wr-refresh-ts', class: 'wr-hint' },
                    _('Updated') + ' ' + wr.fmtTime(Math.floor(Date.now() / 1000)),
                ),
                E('label', { class: 'wr-theme-pick' }, [
                    E('span', { class: 'wr-hint' }, _('主题')),
                    themeSel(this),
                ]),
            ]),
            E('div', { class: 'wr-topo-wrap', id: 'wr-topo' }),
            E('div', { class: 'wr-legend' }, [
                E('span', { class: 'wr-lg-wired' }, _('Wired backhaul')),
                E('span', { class: 'wr-lg-wifi' }, _('Wireless link')),
                E('span', { class: 'wr-lg-good' }, _('Signal good')),
                E('span', { class: 'wr-lg-mid' }, _('Signal fair')),
                E('span', { class: 'wr-lg-bad' }, _('Signal weak')),
            ]),
            E('div', { class: 'cbi-section', style: 'margin-top:1em' }, [
                E('h3', {}, _('Roaming Event Log')),
                E('div', { class: 'wr-log-filter' }, [
                    E(
                        'select',
                        {
                            id: 'wr-flt-type',
                            class: 'cbi-input-select',
                            change: L.bind(function (ev) {
                                this.logFilter.type = ev.target.value;
                                this.renderLog();
                            }, this),
                        },
                        [E('option', { value: '' }, '全部类型')],
                    ),
                    E('input', {
                        type: 'text',
                        id: 'wr-flt-name',
                        class: 'cbi-input-text',
                        placeholder: '设备名称',
                        input: L.bind(function (ev) {
                            this.logFilter.name = ev.target.value;
                            this.renderLog();
                        }, this),
                    }),
                    E('input', {
                        type: 'text',
                        id: 'wr-flt-mac',
                        class: 'cbi-input-text',
                        placeholder: 'MAC 地址',
                        input: L.bind(function (ev) {
                            this.logFilter.mac = ev.target.value;
                            this.renderLog();
                        }, this),
                    }),
                    E('input', {
                        type: 'text',
                        id: 'wr-flt-info',
                        class: 'cbi-input-text',
                        placeholder: '详情关键词',
                        input: L.bind(function (ev) {
                            this.logFilter.info = ev.target.value;
                            this.renderLog();
                        }, this),
                    }),
                    E('button', { class: 'btn', click: L.bind(this.clearLogFilter, this) }, '清空'),
                ]),
                E('div', { id: 'wr-log', class: 'wr-log-scroll' }),
            ]),
        ]);
    },
    handleSaveApply: null,
    handleSave: null,
    handleReset: null,
});
