/*
 * wifiroam LuCI frontend - readable rewrite of luci-app-wifiroam 0.261115.15302.
 *
 * Only the dense one-line layout was re-laid-out (indentation, line breaks,
 * section notes). No logic, text, class name, element id, ubus call,
 * parameter, polling interval or button action was changed.
 */
'use strict';
'require baseclass';
'require rpc';
'require ui';
return baseclass.extend({
    css: function () {
        this.watchDark();
        return E('link', {
            rel: 'stylesheet',
            href: L.resource('wifiroam/wifiroam.css') + '?v=' + this.CSS_VER,
        });
    },
    CSS_VER: '20261115e',
    isDark: function () {
        var de = document.documentElement;
        var dm = de.getAttribute('data-darkmode');
        if (dm === 'true') return true;
        if (dm === 'false') return false;
        var t = de.getAttribute('data-theme');
        if (t === 'dark') return true;
        if (t === 'light') return false;
        return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    },
    watchDark: function () {
        if (this._darkWatch) return;
        this._darkWatch = true;
        var self = this;
        var apply = function () {
            if (document.body) document.body.classList.toggle('wr-dark', self.isDark());
        };
        apply();
        new MutationObserver(apply).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-darkmode', 'data-theme'],
        });
        if (window.matchMedia) {
            var mq = window.matchMedia('(prefers-color-scheme: dark)');
            if (mq.addEventListener) mq.addEventListener('change', apply);
            else if (mq.addListener) mq.addListener(apply);
        }
    },
    // ubus: every daemon call goes through here (object 'wifiroam').
    call: function (method, args) {
        args = args || {};
        var paramSpec = {};
        for (var k in args) paramSpec[k] = undefined;
        var fn = rpc.declare({ object: 'wifiroam', method: method, params: paramSpec });
        return fn(args);
    },
    // Same as call(), but a daemon failure resolves to null instead of rejecting.
    safeCall: function (method, args) {
        return this.call(method, args).catch(function () {
            return null;
        });
    },
    notify: function (kind, msg) {
        var host = document.getElementById('wr-toast-host');
        if (!host) {
            host = E('div', { id: 'wr-toast-host', class: 'wr-toast-host' });
            document.body.appendChild(host);
        }
        var el = E(
            'div',
            { class: 'wr-toast wr-toast-' + (kind || 'info'), title: _('Click to dismiss') },
            msg,
        );
        host.appendChild(el);
        var timer = window.setTimeout(function () {
            dismiss();
        }, 3000);
        function dismiss() {
            window.clearTimeout(timer);
            if (!el.parentNode) return;
            el.classList.add('wr-toast-out');
            window.setTimeout(function () {
                if (el.parentNode) el.parentNode.removeChild(el);
                if (host && !host.children.length)
                    host.parentNode && host.parentNode.removeChild(host);
            }, 220);
        }
        el.addEventListener('click', dismiss);
    },
    setBusy: function (el, on, label) {
        if (!el) return;
        if (on) {
            if (el.dataset.wrIdle == null) el.dataset.wrIdle = el.textContent;
            el.disabled = true;
            el.classList.add('spinning');
            if (label) el.textContent = label;
        } else {
            el.classList.remove('spinning');
            el.disabled = false;
            if (el.dataset.wrIdle != null) {
                el.textContent = el.dataset.wrIdle;
                delete el.dataset.wrIdle;
            }
        }
    },
    setFormDisabled: function (root, on) {
        if (!root) return;
        root.querySelectorAll('input, select, button').forEach(function (el) {
            if (on) el.setAttribute('disabled', 'disabled');
            else el.removeAttribute('disabled');
        });
    },
    pollUntil: function (fn, interval, timeout) {
        var deadline = Date.now() + (timeout || 30000);
        interval = interval || 1500;
        function step() {
            return Promise.resolve(fn()).then(function (done) {
                if (done || Date.now() >= deadline) return !!done;
                return new Promise(function (resolve) {
                    window.setTimeout(resolve, interval);
                }).then(step);
            });
        }
        return step();
    },
    inlineStatus: function (kind, text) {
        var cls = { ok: 'wr-apply-ok', fail: 'wr-apply-fail', pending: 'wr-apply-pending' }[kind];
        return E('span', { class: cls || '' }, text);
    },
    WD_SHORT: ['一', '二', '三', '四', '五', '六', '日'],
    weekdayText: function (days) {
        days = days || [];
        if (days.length === 7) return _('Every day');
        if (days.length === 0) return '-';
        var key = days
            .slice()
            .sort(function (a, b) {
                return a - b;
            })
            .join(',');
        if (key === '1,2,3,4,5') return _('Weekdays');
        if (key === '6,7') return _('Weekend');
        return days
            .map(function (d) {
                return this.WD_SHORT[d - 1] || d;
            }, this)
            .join(' ');
    },
    weekdayPicker: function (selected) {
        var sel = (selected || []).slice();
        var el = E('span', { class: 'wr-wd' });
        var self = this;
        this.WD_SHORT.forEach(function (lbl, i) {
            var d = i + 1;
            var btn = E(
                'button',
                {
                    type: 'button',
                    class: 'wr-wd-btn' + (sel.indexOf(d) >= 0 ? ' active' : ''),
                    click: function () {
                        var k = sel.indexOf(d);
                        if (k >= 0) sel.splice(k, 1);
                        else sel.push(d);
                        btn.classList.toggle('active', k < 0);
                    },
                },
                lbl,
            );
            el.appendChild(btn);
        });
        return {
            el: el,
            value: function () {
                return sel.slice().sort(function (a, b) {
                    return a - b;
                });
            },
            set: function (days) {
                sel = (days || []).slice();
                Array.prototype.forEach.call(el.children, function (b, i) {
                    b.classList.toggle('active', sel.indexOf(i + 1) >= 0);
                });
            },
        };
    },
    // Internet-schedule (ban) editor, shared by the topology detail dialog.
    scheduleControls: function (opts) {
        opts = opts || {};
        var self = this;
        var rawMac = (opts.mac || '').toLowerCase();
        var mac = /^g[0-9a-f]{12}$/.test(rawMac) ? rawMac : rawMac.replace(/[^0-9a-f]/g, '');
        var devSel = null;
        if (!mac && opts.devices) {
            devSel = E(
                'select',
                { class: 'cbi-input-select' },
                opts.devices.map(function (d) {
                    return E('option', { value: d.mac }, d.name || d.mac);
                }),
            );
        }
        var onIn = E('input', { type: 'time', value: '22:00' });
        var offIn = E('input', { type: 'time', value: '07:00' });
        var wd = this.weekdayPicker([1, 2, 3, 4, 5, 6, 7]);
        var stateEl = E('span', { class: 'wr-sched-state' });
        var actions = E('div', { class: 'wr-sched-row' });
        function currentMac() {
            return devSel ? devSel.value || '' : mac;
        }
        var currentRule = null;
        var globalEnabled = opts.enabled !== false;
        var enableCb = E('input', {
            type: 'checkbox',
            class: 'wr-switch-input',
            change: function (ev) {
                if (typeof opts.onEnable === 'function')
                    opts.onEnable(ev.target.checked, ev.target);
            },
        });
        enableCb.checked = globalEnabled;
        enableCb.disabled = opts.loading === true;
        function showActive(rule) {
            currentRule = rule;
            stateEl.className = 'wr-sched-state';
            stateEl.textContent = '';
            if (!globalEnabled) {
                stateEl.textContent = _('Disabled');
                return;
            }
            if (!rule) return;
            stateEl.classList.add(rule.active ? 'on' : 'off');
            stateEl.textContent = rule.active ? _('Blocked now') : _('Allowed now');
        }
        var el = E('div', { class: 'wr-sched' }, [
            E('div', { class: 'wr-sched-head' }, [
                E('b', {}, _('Internet Schedule')),
                E('label', { class: 'wr-appctl-switch' }, [enableCb, ' ' + _('Enable')]),
            ]),
            devSel
                ? E('div', { class: 'wr-sched-row' }, [E('label', {}, _('Device')), devSel])
                : '',
            E('div', { class: 'wr-sched-row' }, [
                E('label', {}, _('Blocked hours')),
                onIn,
                E('span', {}, '—'),
                offIn,
            ]),
            E('div', { class: 'wr-sched-row' }, [E('label', {}, _('Days')), wd.el]),
            E('div', { class: 'wr-sched-row' }, [stateEl]),
            E(
                'div',
                { class: 'wr-hint' },
                _('The schedule applies to every recognized MAC address of this device.'),
            ),
            actions,
        ]);
        var ctl = {
            el: el,
            actions: actions,
            mac: currentMac,
            read: function () {
                return {
                    mac: currentMac(),
                    timeon: onIn.value || '22:00',
                    timeoff: offIn.value || '07:00',
                    weekdays: wd.value().join(' '),
                };
            },
            load: function (rule) {
                rule = rule || {};
                if (rule.mac && devSel) {
                    var have = false;
                    Array.prototype.forEach.call(devSel.options, function (o) {
                        if (o.value === rule.mac) have = true;
                    });
                    if (!have)
                        devSel.appendChild(E('option', { value: rule.mac }, rule.name || rule.mac));
                    devSel.value = rule.mac;
                    devSel.disabled = true;
                }
                onIn.value = rule.timeon || '22:00';
                offIn.value = rule.timeoff || '07:00';
                wd.set(rule.weekdays || [1, 2, 3, 4, 5, 6, 7]);
                showActive(rule);
            },
            clear: function () {
                if (devSel) devSel.disabled = false;
                onIn.value = '22:00';
                offIn.value = '07:00';
                wd.set([1, 2, 3, 4, 5, 6, 7]);
                showActive(null);
            },
            setEnabled: function (on) {
                on = !!on;
                var changed = globalEnabled !== on;
                globalEnabled = on;
                enableCb.checked = on;
                if (!changed) return;
                showActive(currentRule);
                if (on && !currentRule) stateEl.textContent = _('No rule yet');
            },
            setBusy: function (on) {
                enableCb.disabled = !!on;
            },
            setStatus: function (kind, text) {
                if (!globalEnabled) {
                    stateEl.className = 'wr-sched-state';
                    stateEl.textContent = _('Disabled');
                    return;
                }
                stateEl.className = 'wr-sched-state' + (kind ? ' ' + kind : '');
                stateEl.textContent = text || '';
            },
            save: function (extra) {
                var d = ctl.read();
                if (extra) for (var k in extra) d[k] = extra[k];
                return self.call('ban_set', d);
            },
            remove: function () {
                return self.call('ban_del', { mac: currentMac() });
            },
        };
        return ctl;
    },
    // Display formatters: band / rate / time / duration / bytes / uptime / age.
    fmtBand: function (b) {
        return { '2g': '2.4G', '5g': '5G', '6g': '6G' }[b] || b || '-';
    },
    fmtRate: function (mbps) {
        if (mbps == null || mbps === '' || isNaN(+mbps)) return '-';
        var v = +mbps;
        if (v >= 1000) return (v / 1000).toFixed(2) + ' Gbit/s';
        if (v >= 1) return v.toFixed(1) + ' Mbit/s';
        return Math.round(v * 1000) + ' kbit/s';
    },
    fmtTime: function (ts) {
        if (ts == null || ts === '') return '-';
        var d = new Date(+ts * 1000);
        if (isNaN(d.getTime())) return '-';
        var p = function (n) {
            return (n < 10 ? '0' : '') + n;
        };
        return '%d/%s/%s, %s:%s:%s'.format(
            d.getFullYear(),
            p(d.getMonth() + 1),
            p(d.getDate()),
            p(d.getHours()),
            p(d.getMinutes()),
            p(d.getSeconds()),
        );
    },
    fmtDur: function (sec) {
        if (sec == null || sec === '') return '-';
        sec = Math.floor(+sec);
        if (isNaN(sec) || sec <= 0) return '-';
        if (sec < 60) return sec + '秒';
        var h = Math.floor(sec / 3600),
            m = Math.floor((sec % 3600) / 60);
        if (h > 0) return h + '小时' + m + '分';
        return m + '分';
    },
    fmtBytes: function (b) {
        b = Math.floor(+b || 0);
        if (b <= 0) return '0 B';
        if (b < 1024) return b + ' B';
        if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
        if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
        return (b / 1073741824).toFixed(2) + ' GB';
    },
    fmtUptime: function (sec) {
        if (sec == null) return '-';
        sec = +sec;
        var d = Math.floor(sec / 86400),
            h = Math.floor((sec % 86400) / 3600),
            m = Math.floor((sec % 3600) / 60);
        if (d > 0) return d + 'd ' + h + 'h';
        if (h > 0) return h + 'h ' + m + 'm';
        return m + 'm';
    },
    fmtAge: function (ts) {
        if (!ts) return '-';
        var s = Math.floor(Date.now() / 1000) - +ts;
        if (s < 0) s = 0;
        if (s < 60) return s + 's';
        if (s < 3600) return Math.floor(s / 60) + 'm';
        return Math.floor(s / 3600) + 'h';
    },
    rssiClass: function (rssi) {
        if (rssi == null) return '';
        if (rssi >= -60) return 'wr-sig-good';
        if (rssi >= -72) return 'wr-sig-mid';
        return 'wr-sig-bad';
    },
    rssiText: function (rssi) {
        return rssi != null ? rssi + ' dBm' : '-';
    },
    /* 角色变化时整页刷新：被主路由配对成子路由后，导航和页面结构需要按
       新角色重建；解除配对/切换主从角色时同理。home 视图每次轮询都会调它。 */
    _role: null,
    checkRole: function (role) {
        if (!role) return;
        if (this._role == null) { this._role = role; return; }
        if (role == this._role) return;
        this._role = role;
        window.location.reload();
    },
    roleBadge: function (role) {
        var label =
            { cap: _('Main AP'), sap: _('Sub AP'), unconfigured: _('Unconfigured') }[role] || role;
        return E('span', { class: 'wr-badge wr-badge-' + role }, label);
    },
    connText: function (conn) {
        if (!conn) return '-';
        if (conn.type === 'wired') return _('Wired') + (conn.port ? ' (' + conn.port + ')' : '');
        return this.fmtBand(conn.band) + (conn.ssid ? ' ' + conn.ssid : '');
    },
    apNameMap: function (nodes) {
        var map = {};
        (nodes || []).forEach(function (n) {
            if (n.type === 'ap') map[n.id] = n.name || n.mac || n.id;
        });
        return map;
    },
    // Vendor brand table: name pattern -> badge colour, display brand, logo key.
    _BRANDS: [
        [/honor|荣耀/, '#0a5bd3', 'HONOR', 'honor'],
        [/oneplus|one plus|一加/, '#eb0028', 'OnePlus', 'oneplus'],
        [/xiaomi|redmi|poco|小米/, '#ff6900', 'Xiaomi', 'xiaomi'],
        [/realme/, '#ffc915', 'realme', null],
        [/oppo/, '#1a9e4b', 'OPPO', 'oppo'],
        [/\bvivo\b|iqoo/, '#415fff', 'vivo', 'vivo'],
        [/meizu|魅族/, '#00a0e9', 'Meizu', 'meizu'],
        [/huawei|华为/, '#e60012', 'Huawei', 'huawei'],
        [/nubia|redmagic/, '#e60012', 'Nubia', null],
        [/samsung/, '#1428a0', 'Samsung', 'samsung'],
        [/apple|beats/, '#555555', 'Apple', 'apple'],
        [/google|nest labs|fitbit/, '#4285f4', 'Google', 'google'],
        [/motorola/, '#5c3a93', 'Motorola', 'motorola'],
        [/nokia/, '#124191', 'Nokia', 'nokia'],
        [/sony/, '#000000', 'Sony', 'sony'],
        [/lg electronics|\blg\b/, '#a50034', 'LG', 'lg'],
        [/\bhtc\b/, '#009bde', 'HTC', 'htc'],
        [/blackberry/, '#000000', 'BlackBerry', 'blackberry'],
        [/zte|中兴/, '#0068b7', 'ZTE', null],
        [/tcl/, '#e60012', 'TCL', null],
        [/hisense|海信/, '#009944', 'Hisense', null],
        [/skyworth|创维/, '#e60012', 'Skyworth', null],
        [/wiko/, '#e60012', 'Wiko', null],
        [/coolpad|酷派/, '#0068b7', 'Coolpad', null],
        [/gionee|金立/, '#e60012', 'Gionee', null],
        [/tecno|infinix|\bitel\b|transsion|传音/, '#0068b7', 'Transsion', null],
        [/amazfit|huami|zepp/, '#e60012', 'Amazfit', null],
        [/garmin/, '#007cc3', 'Garmin', null],
        [/suunto/, '#e60012', 'Suunto', null],
        [/withings/, '#00a0e9', 'Withings', null],
        [/mobvoi|ticwatch/, '#00a0e9', 'Mobvoi', null],
        [/\bpolar\b/, '#e60012', 'Polar', null],
        [/coros/, '#005bac', 'COROS', null],
        [/fossil/, '#555555', 'Fossil', null],
        [/intel/, '#0068b5', 'Intel', 'intel'],
        [/advanced micro devices|\bamd\b/, '#ed1c24', 'AMD', 'amd'],
        [/nvidia/, '#76b900', 'NVIDIA', 'nvidia'],
        [/nxp|freescale/, '#00a3e0', 'NXP', 'nxp'],
        [/broadcom/, '#cc0000', 'Broadcom', 'broadcom'],
        [/mediatek|\bmtk\b/, '#ed6d00', 'MediaTek', 'mediatek'],
        [/qualcomm|atheros/, '#3253dc', 'Qualcomm', 'qualcomm'],
        [/espressif/, '#e7352c', 'Espressif', 'espressif'],
        [/nordic semiconductor/, '#00a9ce', 'Nordic Semiconductor', 'nordicsemiconductor'],
        [/raspberry pi/, '#c51a4a', 'Raspberry Pi', 'raspberrypi'],
        [/arduino/, '#00979d', 'Arduino', 'arduino'],
        [/micro:?bit/, '#00ed00', 'micro:bit', 'microbit'],
        [/ralink/, '#0066b3', 'Ralink', null],
        [/marvell/, '#0066b3', 'Marvell', null],
        [/stmicro|st micro/, '#0066b3', 'STMicro', null],
        [/texas instruments/, '#cc0000', 'Texas Instruments', null],
        [/microchip|atmel/, '#e60012', 'Microchip', null],
        [/silicon lab/, '#e60012', 'Silicon Labs', null],
        [/cypress|infineon/, '#00a0e9', 'Infineon', null],
        [/renesas/, '#0066b3', 'Renesas', null],
        [/semtech/, '#0066b3', 'Semtech', null],
        [/quectel/, '#005bac', 'Quectel', null],
        [/fibocom/, '#005bac', 'Fibocom', null],
        [/simcom/, '#005bac', 'SIMCom', null],
        [/unisoc|spreadtrum/, '#0068b7', 'UNISOC', null],
        [/rockchip/, '#0068b7', 'Rockchip', null],
        [/allwinner/, '#0068b7', 'Allwinner', null],
        [/amlogic/, '#0066b3', 'Amlogic', null],
        [/hisilicon/, '#e60012', 'HiSilicon', null],
        [/sigmastar/, '#0066b3', 'SigmaStar', null],
        [/ingenic/, '#0066b3', 'Ingenic', null],
        [/bouffalo/, '#0066b3', 'Bouffalo', null],
        [/telink/, '#0066b3', 'Telink', null],
        [/beken/, '#0066b3', 'Beken', null],
        [/liteon|lite-on/, '#e60012', 'Lite-On', null],
        [/compal/, '#005bac', 'Compal', null],
        [/wistron/, '#005bac', 'Wistron', null],
        [/quanta/, '#005bac', 'Quanta', null],
        [/inventec/, '#005bac', 'Inventec', null],
        [/pegatron/, '#005bac', 'Pegatron', null],
        [/azurewave/, '#005bac', 'AzureWave', null],
        [/murata/, '#005bac', 'Murata', null],
        [/ampak/, '#005bac', 'AMPAK', null],
        [/\bdell\b/, '#007db8', 'Dell', 'dell'],
        [/hewlett|\bhp\b/, '#0096d6', 'HP', 'hp'],
        [/lenovo|联想/, '#e2231a', 'Lenovo', 'lenovo'],
        [/asustek|asus|\brog\b/, '#00539b', 'ASUS', 'asus'],
        [/micro-star|\bmsi\b/, '#ff0000', 'MSI', 'msi'],
        [/razer/, '#00ff00', 'Razer', 'razer'],
        [/supermicro/, '#1f3c88', 'Supermicro', 'supermicro'],
        [/gigabyte/, '#0c2c56', 'GIGABYTE', null],
        [/\bacer\b/, '#83b81a', 'Acer', null],
        [/microsoft|surface/, '#00a4ef', 'Microsoft', null],
        [/\bvaio\b/, '#555555', 'VAIO', null],
        [/hasee|神舟/, '#e60012', 'Hasee', null],
        [/mechrevo|机械革命/, '#e60012', 'MECHREVO', null],
        [/thunderobot|雷神/, '#00a0e9', 'ThundeRobot', null],
        [/machenike|机械师/, '#e60012', 'MACHENIKE', null],
        [/colorful|七彩虹/, '#e60012', 'Colorful', null],
        [/dynabook/, '#ff0000', 'Dynabook', null],
        [/logitech|\blogi\b/, '#00b0b9', 'Logitech', null],
        [/corsair/, '#ffcc00', 'Corsair', null],
        [/steelseries/, '#ff5200', 'SteelSeries', null],
        [/hyperx/, '#c8102e', 'HyperX', null],
        [/ugreen|绿联/, '#00a550', 'UGREEN', null],
        [/orico/, '#005bac', 'ORICO', null],
        [/baseus|倍思/, '#e60012', 'Baseus', null],
        [/aukey/, '#005bac', 'AUKEY', null],
        [/anker|eufy/, '#00a0e9', 'Anker', null],
        [/satechi/, '#555555', 'Satechi', null],
        [/startech/, '#e60012', 'StarTech', null],
        [/fujitsu/, '#e60012', 'Fujitsu', 'fujitsu'],
        [/toshiba/, '#ff0000', 'Toshiba', 'toshiba'],
        [/panasonic/, '#0041a3', 'Panasonic', 'panasonic'],
        [/sharp/, '#e60012', 'Sharp', 'sharp'],
        [/kyocera/, '#df0029', 'Kyocera', 'kyocera'],
        [/epson/, '#003399', 'Epson', 'epson'],
        [/canon/, '#cc0000', 'Canon', null],
        [/brother/, '#0060a9', 'Brother', null],
        [/xerox/, '#d22030', 'Xerox', null],
        [/ricoh/, '#d71920', 'Ricoh', null],
        [/lexmark/, '#e60000', 'Lexmark', null],
        [/zebra/, '#000000', 'Zebra', null],
        [/synology|群晖/, '#0072bc', 'Synology', 'synology'],
        [/qnap/, '#0b6fb4', 'QNAP', 'qnap'],
        [/asustor/, '#1a4b8c', 'ASUSTOR', null],
        [/buffalo/, '#e60012', 'Buffalo', null],
        [/terra.?master/, '#0055a5', 'TerraMaster', null],
        [/western digital|sandisk|hgst/, '#005195', 'Western Digital', null],
        [/seagate/, '#6eb43f', 'Seagate', 'seagate'],
        [/netapp/, '#0067c5', 'NetApp', 'netapp'],
        [/tp-link|普联|tapo|kasa/, '#00695c', 'TP-Link', 'tplink'],
        [/netgear/, '#5b92e5', 'Netgear', 'netgear'],
        [/ubiquiti|unifi|ubnt/, '#0559c9', 'Ubiquiti', 'ubiquiti'],
        [/mikrotik/, '#293b57', 'MikroTik', 'mikrotik'],
        [/cisco|meraki/, '#1ba0d7', 'Cisco', 'cisco'],
        [/aruba/, '#01a982', 'Aruba', null],
        [/linksys/, '#1b61c9', 'Linksys', 'linksys'],
        [/d-link|dlink/, '#0066b3', 'D-Link', null],
        [/fortinet/, '#ee1c25', 'Fortinet', 'fortinet'],
        [/palo alto/, '#fa582d', 'Palo Alto Networks', 'paloaltonetworks'],
        [/juniper/, '#84b135', 'Juniper', null],
        [/zyxel/, '#00539b', 'ZYXEL', null],
        [/sophos/, '#005bb3', 'Sophos', null],
        [/check point/, '#ee3124', 'Check Point', null],
        [/ruijie|锐捷/, '#0055a5', 'Ruijie', null],
        [/\bh3c\b/, '#005bac', 'H3C', null],
        [/tenda|腾达/, '#e2231a', 'Tenda', null],
        [/totolink/, '#e60012', 'TOTOLINK', null],
        [/mercusys|水星/, '#0055a5', 'MERCUSYS', null],
        [/gl[.-]?inet|gl technologies/, '#00a0e9', 'GL.iNet', null],
        [/comfast/, '#005bac', 'COMFAST', null],
        [/wavlink/, '#005bac', 'Wavlink', null],
        [/netis/, '#005bac', 'netis', null],
        [/edimax/, '#005bac', 'EDIMAX', null],
        [/draytek/, '#005bac', 'DrayTek', null],
        [/netcore|磊科/, '#005bac', 'netcore', null],
        [/fiberhome|烽火/, '#e60012', 'FiberHome', null],
        [/raisecom/, '#005bac', 'Raisecom', null],
        [/ericsson/, '#005bac', 'Ericsson', null],
        [/alcatel/, '#005bac', 'Alcatel', null],
        [/arris|commscope/, '#005bac', 'ARRIS', null],
        [/technicolor|sagemcom|vantiva/, '#005bac', 'Vantiva', null],
        [/arcadyan/, '#005bac', 'Arcadyan', null],
        [/sercomm/, '#005bac', 'Sercomm', null],
        [/actiontec/, '#005bac', 'Actiontec', null],
        [/cambium/, '#005bac', 'Cambium', null],
        [/mimosa/, '#005bac', 'Mimosa', null],
        [/engenius/, '#005bac', 'EnGenius', null],
        [/grandstream/, '#005bac', 'Grandstream', null],
        [/yealink/, '#005bac', 'Yealink', null],
        [/polycom/, '#005bac', 'Polycom', null],
        [/edgecore/, '#005bac', 'Edgecore', null],
        [/maipu/, '#005bac', 'Maipu', null],
        [/airties/, '#005bac', 'Airties', null],
        [/avm gmbh|fritz/, '#e2001a', 'AVM', 'avm'],
        [/sonos/, '#000000', 'Sonos', 'sonos'],
        [/bose/, '#000000', 'Bose', 'bose'],
        [/harman|\bjbl\b/, '#ff3300', 'JBL', 'jbl'],
        [/denon/, '#000000', 'Denon', 'denon'],
        [/yamaha/, '#003399', 'Yamaha', null],
        [/sennheiser/, '#000000', 'Sennheiser', 'sennheiser'],
        [/audio-technica|audiotechnica/, '#000000', 'Audio-Technica', 'audiotechnica'],
        [/philips|signify/, '#0b5ed7', 'Philips', 'philipshue'],
        [/tuya|涂鸦/, '#ff4800', 'Tuya', null],
        [/midea|美的/, '#00a0e9', 'Midea', null],
        [/gree|格力/, '#00843d', 'Gree', null],
        [/haier|海尔/, '#005bac', 'Haier', null],
        [/changhong|长虹/, '#e60012', 'Changhong', null],
        [/konka|康佳/, '#e60012', 'Konka', null],
        [/\baux\b|奥克斯/, '#005bac', 'AUX', null],
        [/yeelight/, '#ffcc00', 'Yeelight', null],
        [/osram|ledvance/, '#e60012', 'LEDVANCE', null],
        [/sengled/, '#005bac', 'Sengled', null],
        [/ikea|tradfri/, '#005bac', 'IKEA', null],
        [/lifx/, '#00a0e9', 'LIFX', null],
        [/meross/, '#00a0e9', 'meross', null],
        [/broadlink/, '#00a0e9', 'BroadLink', null],
        [/honeywell|resideo/, '#e60012', 'Honeywell', null],
        [/somfy/, '#005bac', 'Somfy', null],
        [/dyson/, '#555555', 'Dyson', null],
        [/black ?shark|黑鲨/, '#333333', 'Black Shark', null],
        [/sharkninja|\bshark\b/, '#005bac', 'Shark', null],
        [/narwal/, '#00a0e9', 'Narwal', null],
        [/tineco/, '#00a0e9', 'Tineco', null],
        [/littleswan|小天鹅/, '#005bac', 'LittleSwan', null],
        [/colmo/, '#555555', 'COLMO', null],
        [/joyoung|九阳/, '#e60012', 'Joyoung', null],
        [/supor|苏泊尔/, '#e60012', 'SUPOR', null],
        [/galanz|格兰仕/, '#e60012', 'Galanz', null],
        [/fotile|方太/, '#e60012', 'FOTILE', null],
        [/robam|老板/, '#005bac', 'ROBAM', null],
        [/vatti|华帝/, '#e60012', 'VATTI', null],
        [/daikin/, '#005bac', 'Daikin', null],
        [/hitachi|日立/, '#e60012', 'Hitachi', null],
        [/mitsubishi|三菱/, '#e60012', 'Mitsubishi', null],
        [/carrier|开利/, '#005bac', 'Carrier', null],
        [/trane|特灵/, '#005bac', 'Trane', null],
        [/bosch|博世/, '#e60012', 'Bosch', null],
        [/siemens|西门子/, '#009999', 'Siemens', null],
        [/electrolux/, '#005bac', 'Electrolux', null],
        [/whirlpool|惠而浦/, '#005bac', 'Whirlpool', null],
        [/miele/, '#e60012', 'Miele', null],
        [/beko/, '#005bac', 'Beko', null],
        [/arcelik/, '#005bac', 'Arcelik', null],
        [/grundig/, '#005bac', 'Grundig', null],
        [/candy|hoover/, '#e60012', 'Candy', null],
        [/gorenje/, '#e60012', 'Gorenje', null],
        [/smeg/, '#555555', 'Smeg', null],
        [/ge appliances|general electric/, '#005bac', 'GE', null],
        [/frigidaire/, '#005bac', 'Frigidaire', null],
        [/noritz|能率/, '#005bac', 'Noritz', null],
        [/rinnai|林内/, '#e60012', 'Rinnai', null],
        [/a\.?o\.? ?smith|史密斯/, '#005bac', 'A.O.Smith', null],
        [/vanward|万和/, '#e60012', 'Vanward', null],
        [/smartisan|锤子/, '#555555', 'Smartisan', null],
        [/realtek/, '#0066b3', 'Realtek', null],
        [/hon hai|foxconn/, '#e60012', 'Foxconn', null],
        [/aqara|lumi/, '#19b969', 'Aqara', null],
        [/sonoff|itead/, '#1a1aff', 'SONOFF', null],
        [/shelly/, '#00a3e0', 'Shelly', 'shelly'],
        [/ecovacs|科沃斯/, '#00a0e9', 'Ecovacs', 'ecovacs'],
        [/irobot/, '#6cb33f', 'iRobot', 'irobot'],
        [/roborock|石头/, '#00a3e0', 'Roborock', null],
        [/dreame|追觅/, '#00a3e0', 'Dreame', null],
        [/switchbot/, '#333333', 'SwitchBot', null],
        [/wemo/, '#0079c1', 'WeMo', 'wemo'],
        [/belkin/, '#003366', 'Belkin', null],
        [/govee/, '#00a3e0', 'Govee', null],
        [/nanoleaf/, '#00a3e0', 'Nanoleaf', null],
        [/ecobee/, '#00a3e0', 'Ecobee', null],
        [/ring llc|\bring\b/, '#1a73e8', 'Ring', 'ring'],
        [/arlo/, '#49b48a', 'Arlo', 'arlo'],
        [/wyze/, '#00b2e3', 'Wyze', 'wyze'],
        [/roku/, '#662d91', 'Roku', 'roku'],
        [/hikvision|海康/, '#e60012', 'Hikvision', null],
        [/dahua|大华/, '#0057a8', 'Dahua', null],
        [/ezviz|萤石/, '#00a0e9', 'EZVIZ', null],
        [/reolink/, '#00a0e9', 'Reolink', null],
        [/uniview|宇视/, '#0057a8', 'Uniview', null],
        [/amcrest/, '#0057a8', 'Amcrest', null],
        [/vivotek/, '#0057a8', 'Vivotek', null],
        [/axis comm/, '#0066b3', 'Axis', null],
        [/hanwha/, '#e60012', 'Hanwha', null],
        [/avigilon/, '#005bac', 'Avigilon', null],
        [/pelco/, '#005bac', 'Pelco', null],
        [/mobotix/, '#005bac', 'MOBOTIX', null],
        [/geovision/, '#005bac', 'GeoVision', null],
        [/lorex/, '#005bac', 'Lorex', null],
        [/annke/, '#005bac', 'ANNKE', null],
        [/swann/, '#005bac', 'Swann', null],
        [/tiandy|天地伟业/, '#005bac', 'Tiandy', null],
        [/\btvt\b/, '#005bac', 'TVT', null],
        [/lilin/, '#005bac', 'LILIN', null],
        [/\bajax\b/, '#00a0e9', 'Ajax', null],
        [/\byale\b/, '#e60012', 'Yale', null],
        [/august home/, '#555555', 'August', null],
        [/schlage/, '#005bac', 'Schlage', null],
        [/kwikset/, '#005bac', 'Kwikset', null],
        [/ultraloq/, '#005bac', 'Ultraloq', null],
        [/kaadas|凯迪仕/, '#005bac', 'Kaadas', null],
        [/dessmann|德施曼/, '#005bac', 'Dessmann', null],
        [/loock|鹿客/, '#00a0e9', 'Loock', null],
        [/avast/, '#ff8800', 'Avast', 'avast'],
        [/kaspersky/, '#006782', 'Kaspersky', 'kaspersky'],
        [/trend micro|trendmicro/, '#d71920', 'Trend Micro', 'trendmicro'],
        [/kingston/, '#c8102e', 'Kingston', 'kingstontechnology'],
        [/vestel/, '#e60000', 'Vestel', 'vestel'],
        [/tesla/, '#e82127', 'Tesla', null],
        [/byd|比亚迪/, '#005bac', 'BYD', null],
        [/\bnio\b|蔚来/, '#00a0e9', 'NIO', null],
        [/xpeng|小鹏/, '#005bac', 'XPeng', null],
        [/li auto|理想/, '#005bac', 'Li Auto', null],
        [/geely|吉利/, '#005bac', 'Geely', null],
        [/\bbmw\b/, '#0066b3', 'BMW', null],
        [/mercedes|daimler/, '#555555', 'Mercedes', null],
        [/\baudi\b/, '#e60012', 'Audi', null],
        [/volkswagen|\bvw\b/, '#005bac', 'Volkswagen', null],
        [/toyota/, '#e60012', 'Toyota', null],
        [/honda/, '#e60012', 'Honda', null],
        [/\bford\b/, '#005bac', 'Ford', null],
        [/hyundai/, '#005bac', 'Hyundai', null],
        [/\bkia\b/, '#e60012', 'Kia', null],
        [/volvo/, '#005bac', 'Volvo', null],
        [/polestar/, '#555555', 'Polestar', null],
        [/porsche/, '#e60012', 'Porsche', null],
        [/nintendo|任天堂/, '#e60012', 'Nintendo', null],
        [/\bvalve\b/, '#555555', 'Valve', null],
        [/\bdji\b/, '#555555', 'DJI', null],
        [/gopro/, '#00a0e9', 'GoPro', null],
        [/parrot/, '#005bac', 'Parrot', null],
        [/autel/, '#e60012', 'Autel', null],
        [/yuneec/, '#005bac', 'Yuneec', null],
        [/nikon/, '#ffcc00', 'Nikon', null],
        [/olympus/, '#005bac', 'Olympus', null],
        [/insta360/, '#e60012', 'Insta360', null],
        [/fujifilm/, '#00843d', 'Fujifilm', null],
        [/\boki\b|okidata/, '#005bac', 'OKI', null],
        [/konica|minolta/, '#005bac', 'Konica', null],
        [/pantum|奔图/, '#005bac', 'Pantum', null],
        [/vmware/, '#555555', 'VMware', null],
        [/oracle|virtualbox/, '#e60012', 'Oracle', null],
        [/parallels/, '#005bac', 'Parallels', null],
        [/amazon|kindle/, '#ff9900', 'Amazon', null],
    ],
    _oui: null,
    _logos: null,
    _devices: null,
    brandOf: function (name) {
        var s = (name || '').toLowerCase();
        for (var i = 0; i < this._BRANDS.length; i++) {
            var b = this._BRANDS[i];
            if (b[0].test(s)) return { color: b[1], brand: b[2], logo: b[3] };
        }
        return { color: this._hashColor(name), brand: name, logo: null };
    },
    useVendorLogos: function (map) {
        if (map) this._logos = map;
    },
    useDevices: function (mod) {
        if (mod) this._devices = mod;
    },
    vendorLogo: function (name) {
        if (!this._logos) return null;
        var b = this.brandOf(name);
        return b.logo ? this._logos[b.logo] || null : null;
    },
    useOui: function (raw) {
        if (!raw || this._oui) return;
        var map = {};
        var list = raw.split(';');
        for (var i = 0; i < list.length; i++) {
            var p = list[i].indexOf(':');
            if (p > 0) map[list[i].slice(0, p)] = list[i].slice(p + 1);
        }
        this._oui = map;
    },
    _hashColor: function (name) {
        var h = 0;
        for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
        var hue = Math.abs(h) % 360;
        return 'hsl(' + hue + ',62%,42%)';
    },
    vendorOf: function (mac, hostname) {
        var hex = (mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
        if (hex.length < 12) return null;
        var random = !!(parseInt(hex.slice(0, 2), 16) & 0x02);
        var name = null,
            source = null;
        if (!random && this._oui) {
            var keys = [hex.slice(0, 9), hex.slice(0, 7), hex.slice(0, 6)];
            for (var i = 0; i < keys.length && !name; i++) name = this._oui[keys[i]] || null;
            if (name) source = 'oui';
        }
        if (!name && this._devices) {
            name = this._devices.nameVendor(hostname);
            if (name) source = 'hostname';
        }
        if (!name) {
            if (random)
                return {
                    name: _('Randomized MAC'),
                    color: '#90a4ae',
                    kind: null,
                    initial: '?',
                    random: true,
                };
            return null;
        }
        var b = this.brandOf(name);
        return {
            name: name,
            brand: b.brand,
            color: b.color,
            kind: this.vendorKind(name),
            initial: (b.brand || name).charAt(0).toUpperCase(),
            logo: b.logo && this._logos ? this._logos[b.logo] || null : null,
            source: source,
            random: random,
        };
    },
    kindOf: function (vendor, name) {
        if (this._devices) return this._devices.kindFor(vendor, name);
        return this.vendorKind(vendor);
    },
    vendorKind: function (name) {
        return this._devices ? this._devices.vendorKind(name) : null;
    },
    // Shared status strip shown at the top of every page.
    statusBar: function (st) {
        var roamOn = st.roam && st.roam.enabled;
        return E('div', { class: 'wr-statusbar' }, [
            E('span', { class: 'wr-item' }, [_('Role'), this.roleBadge(st.role)]),
            E('span', { class: 'wr-item' }, [_('Device'), E('b', {}, st.name || '-')]),
            E('span', { class: 'wr-item' }, [_('IP'), E('b', {}, st.ip || '-')]),
            E('span', { class: 'wr-item' }, [
                _('Member APs'),
                E('b', {}, '%d / %d'.format(st.peers_online || 0, st.peers_total || 0)),
            ]),
            E('span', { class: 'wr-item' }, [
                _('Clients'),
                E('b', {}, '' + (st.clients_total || 0)),
            ]),
            E('span', { class: 'wr-item' }, [
                _('Seamless Roaming'),
                E(
                    'span',
                    { class: 'wr-badge ' + (roamOn ? 'wr-badge-on' : 'wr-badge-off') },
                    roamOn ? _('Enabled') : _('Disabled'),
                ),
            ]),
        ]);
    },
});
