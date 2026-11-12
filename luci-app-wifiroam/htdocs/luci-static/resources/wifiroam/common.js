// wifiroam shared helpers for LuCI views
'use strict';
'require baseclass';
'require rpc';
'require ui';

return baseclass.extend({
	css: function() {
		/* 带上版本号：uhttpd 对外链样式只发 ETag/Last-Modified，浏览器会按
		   启发式规则长时间复用旧缓存。改动样式后手动递增 CSS_VER 即可失效 */
		let href = L.resource('wifiroam/wifiroam.css') + '?v=' + this.CSS_VER;
		let link = document.getElementById('wr-css-link');

		if (!link) {
			link = E('link', { id: 'wr-css-link', rel: 'stylesheet', href: href });
			document.head.appendChild(link);
		}
		else if (link.getAttribute('href') != href) {
			link.setAttribute('href', href);
		}

		/* 样式挂在 head，页面切换时不会被 LuCI 清掉；这里不再返回 link */
		return E([]);
	},

	CSS_VER: '20261113a',

	_navState: null,
	_navHashBound: false,

	/* 记住最近一次的角色/运行状态：页面切换时导航栏在数据返回前
	   也能按上一次的状态渲染，避免先只显示「首页」再补上其他页签 */
	navState: function(opts) {
		if (opts) {
			this._navState = {
				running: opts.running !== false,
				role: opts.role || '',
			};
			try {
				window.sessionStorage.setItem('wr-nav-state',
					JSON.stringify(this._navState));
			} catch (e) { /* 隐私模式或存储不可用 */ }
		}

		if (this._navState)
			return this._navState;

		try {
			let s = JSON.parse(window.sessionStorage.getItem('wr-nav-state'));
			if (s && typeof s.running == 'boolean') {
				this._navState = s;
				return s;
			}
		} catch (e) { /* ignore */ }

		/* 首次访问：先展示全部页签，状态返回后再按角色收敛 */
		return { running: true, role: '' };
	},

	/* 导航栏挂在 #view 之外：LuCI 加载新视图时只清空 #view 并显示
	   Loading，页签因此不会随页面切换消失 */
	mountNav: function(active, opts) {
		let state = this.navState(opts);
		let vp = document.getElementById('view');
		if (!vp || !vp.parentNode)
			return null;

		/* 页签挂在 #view 外，先确保样式已加载，避免切换瞬间裸链接 */
		this.css();

		if (!this._navHashBound) {
			this._navHashBound = true;
			window.addEventListener('hashchange', L.bind(function() {
				let where = window.location.hash + window.location.pathname;
				if (where.indexOf('admin/mesh/management') < 0)
					this.hideNav();
			}, this));
		}

		let host = document.getElementById('wr-global-nav');
		if (!host) {
			host = E('div', { id: 'wr-global-nav' });
			vp.parentNode.insertBefore(host, vp);
		}

		let sig = active + ':' + (state.running ? '1' : '0') + ':' + (state.role || '');
		if (host.getAttribute('data-sig') != sig) {
			while (host.firstChild)
				host.removeChild(host.firstChild);
			host.appendChild(this.navTabs(active, state));
			host.setAttribute('data-sig', sig);
		}
		host.style.display = '';
		return host;
	},

	hideNav: function() {
		let host = document.getElementById('wr-global-nav');
		if (host)
			host.style.display = 'none';
	},

	/* 网络管理页签：未启动时只保留首页；SAP 只保留首页和无线设置 */
	navTabs: function(active, opts) {
		opts = opts || {};

		var running = (opts.running !== false);
		var role = opts.role || '';
		var items = [];

		if (running) {
			items.push([ 'home',     _('首页'),     'admin/mesh/management' ]);
			if (role !== 'sap') {
				items.push([ 'topology', _('网络拓扑'), 'admin/mesh/management/topology' ]);
				items.push([ 'clients',  _('客户端'),   'admin/mesh/management/clients' ]);
			}
			items.push([ 'settings', _('无线设置'), 'admin/mesh/management/settings' ]);
			if (role !== 'sap')
				items.push([ 'advanced', _('高级设置'), 'admin/mesh/management/advanced' ]);
		}
		else {
			items.push([ 'home', _('首页'), 'admin/mesh/management' ]);
		}

		return E('div', { 'class': 'wr-navtabs' }, items.map(function(it) {
			var attrs = {
				'class': 'wr-navtab' + (active === it[0] ? ' active' : ''),
				href: L.url(it[2])
			};

			if (active === it[0])
				attrs['aria-current'] = 'page';

			return E('a', attrs, it[1]);
		}));
	},

	/* LuCI 上游无 ubus.js，统一经 rpc.declare 调 /ubus 端点 */
	call: function(method, args) {
		args = args || {};
		var paramSpec = {};
		for (var k in args) paramSpec[k] = undefined;
		var fn = rpc.declare({ object: 'wifiroam', method: method, params: paramSpec });
		return fn(args);
	},

	/* 同 call()，但失败（守护进程未运行 / 参数被拒）时返回 null，
	   避免页面拿到 undefined 直接抛异常白屏 */
	safeCall: function(method, args) {
		return this.call(method, args).catch(function() {
			return null;
		});
	},

	/* 浮动提示：kind = info | success | warning | danger
	   不占用页面布局，3 秒后自动消失，点击可立即关闭 */
	notify: function(kind, msg) {
		var host = document.getElementById('wr-toast-host');
		if (!host) {
			host = E('div', { id: 'wr-toast-host', 'class': 'wr-toast-host' });
			document.body.appendChild(host);
		}

		var el = E('div', {
			'class': 'wr-toast wr-toast-' + (kind || 'info'),
			title: _('Click to dismiss'),
		}, msg);

		host.appendChild(el);

		var timer = window.setTimeout(function() { dismiss(); }, 3000);

		function dismiss() {
			window.clearTimeout(timer);
			if (!el.parentNode) return;
			el.classList.add('wr-toast-out');
			window.setTimeout(function() {
				if (el.parentNode) el.parentNode.removeChild(el);
				if (host && !host.children.length) host.parentNode && host.parentNode.removeChild(host);
			}, 220);
		}

		el.addEventListener('click', dismiss);
	},

	/* 按钮忙碌态：禁用 + 转圈 + 临时文案，结束后自动还原 */
	setBusy: function(el, on, label) {
		if (!el) return;

		if (on) {
			if (el.dataset.wrIdle == null)
				el.dataset.wrIdle = el.textContent;
			el.disabled = true;
			el.classList.add('spinning');
			if (label)
				el.textContent = label;
		}
		else {
			el.classList.remove('spinning');
			el.disabled = false;
			if (el.dataset.wrIdle != null) {
				el.textContent = el.dataset.wrIdle;
				delete el.dataset.wrIdle;
			}
		}
	},

	/* 整块表单禁用（不适用于需要保留原状态的控件） */
	setFormDisabled: function(root, on) {
		if (!root) return;

		root.querySelectorAll('input, select, button').forEach(function(el) {
			if (on)
				el.setAttribute('disabled', 'disabled');
			else
				el.removeAttribute('disabled');
		});
	},

	/* 轮询直到 fn() 解析为真值，或超时。返回 Promise<boolean> */
	pollUntil: function(fn, interval, timeout) {
		var deadline = Date.now() + (timeout || 30000);

		interval = interval || 1500;

		function step() {
			return Promise.resolve(fn()).then(function(done) {
				if (done || Date.now() >= deadline)
					return !!done;

				return new Promise(function(resolve) {
					window.setTimeout(resolve, interval);
				}).then(step);
			});
		}

		return step();
	},

	/* 一行内联状态文本：kind = ok | fail | pending */
	inlineStatus: function(kind, text) {
		var cls = { ok: 'wr-apply-ok', fail: 'wr-apply-fail', pending: 'wr-apply-pending' }[kind];
		return E('span', { 'class': cls || '' }, text);
	},

	fmtBand: function(b) {
		return { '2g': '2.4G', '5g': '5G', '6g': '6G' }[b] || (b || '-');
	},

	/* 速率统一按「数值 + 单位/s」展示：kbit/s、Mbit/s、Gbit/s */
	fmtRate: function(mbps) {
		if (mbps == null || mbps === '' || isNaN(+mbps)) return '-';
		var v = +mbps;
		if (v >= 1000) return (v / 1000).toFixed(2) + ' Gbit/s';
		if (v >= 1) return v.toFixed(1) + ' Mbit/s';
		return Math.round(v * 1000) + ' kbit/s';
	},

	/* 秒级时间戳 → 24 小时制：2026/10/25, 11:01:32 */
	fmtTime: function(ts) {
		if (ts == null || ts === '') return '-';
		var d = new Date(+ts * 1000);
		if (isNaN(d.getTime())) return '-';
		var p = function(n) { return (n < 10 ? '0' : '') + n; };
		return '%d/%s/%s, %s:%s:%s'.format(
			d.getFullYear(), p(d.getMonth() + 1), p(d.getDate()),
			p(d.getHours()), p(d.getMinutes()), p(d.getSeconds()));
	},

	/* 时长（秒）→ 中文短语：42秒 / 12分 / 1小时23分 */
	fmtDur: function(sec) {
		if (sec == null || sec === '') return '-';
		sec = Math.floor(+sec);
		if (isNaN(sec) || sec <= 0) return '-';
		if (sec < 60) return sec + '秒';
		var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
		if (h > 0) return h + '小时' + m + '分';
		return m + '分';
	},

	/* 字节 → 人类可读：512 B / 12.3 KB / 45.6 MB / 1.24 GB */
	fmtBytes: function(b) {
		b = Math.floor(+b || 0);
		if (b <= 0) return '0 B';
		if (b < 1024) return b + ' B';
		if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
		if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
		return (b / 1073741824).toFixed(2) + ' GB';
	},

	fmtUptime: function(sec) {
		if (sec == null) return '-';
		sec = +sec;
		var d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600),
		    m = Math.floor(sec % 3600 / 60);
		if (d > 0) return d + 'd ' + h + 'h';
		if (h > 0) return h + 'h ' + m + 'm';
		return m + 'm';
	},

	/* 相对时间：42s / 12m / 3h */
	fmtAge: function(ts) {
		if (!ts) return '-';
		var s = Math.floor(Date.now() / 1000) - (+ts);
		if (s < 0) s = 0;
		if (s < 60) return s + 's';
		if (s < 3600) return Math.floor(s / 60) + 'm';
		return Math.floor(s / 3600) + 'h';
	},

	rssiClass: function(rssi) {
		if (rssi == null) return '';
		if (rssi >= -60) return 'wr-sig-good';
		if (rssi >= -72) return 'wr-sig-mid';
		return 'wr-sig-bad';
	},

	rssiText: function(rssi) {
		return (rssi != null) ? rssi + ' dBm' : '-';
	},

	roleBadge: function(role) {
		var label = { cap: _('Main AP'), sap: _('Sub AP'), unconfigured: _('Unconfigured') }[role] || role;
		return E('span', { 'class': 'wr-badge wr-badge-' + role }, label);
	},

	connText: function(conn) {
		if (!conn) return '-';
		if (conn.type === 'wired')
			return _('Wired') + (conn.port ? ' (' + conn.port + ')' : '');
		return this.fmtBand(conn.band) + (conn.ssid ? ' ' + conn.ssid : '');
	},

	apNameMap: function(nodes) {
		var map = {};
		(nodes || []).forEach(function(n) {
			if (n.type === 'ap') map[n.id] = n.name || n.mac || n.id;
		});
		return map;
	},

	/* 厂商品牌库：[厂商名匹配, 品牌色, 品牌简称, logo slug]。
	   简称用于未收录 logo 时的首字母兜底；logo 数据由 logos.js 注入。
	   顺序从具体品牌到宽泛关键词，命中即返回。 */
	_BRANDS: [
		[ /honor|荣耀/, '#0a5bd3', 'HONOR', 'honor' ],
		[ /oneplus|one plus|一加/, '#eb0028', 'OnePlus', 'oneplus' ],
		[ /xiaomi|redmi|poco|小米/, '#ff6900', 'Xiaomi', 'xiaomi' ],
		[ /realme/, '#ffc915', 'realme', null ],
		[ /oppo/, '#1a9e4b', 'OPPO', 'oppo' ],
		[ /\bvivo\b/, '#415fff', 'vivo', 'vivo' ],
		[ /meizu|魅族/, '#00a0e9', 'Meizu', 'meizu' ],
		[ /huawei|华为/, '#e60012', 'Huawei', 'huawei' ],
		[ /nubia/, '#e60012', 'Nubia', null ],
		[ /samsung/, '#1428a0', 'Samsung', 'samsung' ],
		[ /apple/, '#555555', 'Apple', 'apple' ],
		[ /google|nest labs/, '#4285f4', 'Google', 'google' ],
		[ /motorola/, '#5c3a93', 'Motorola', 'motorola' ],
		[ /nokia/, '#124191', 'Nokia', 'nokia' ],
		[ /sony/, '#000000', 'Sony', 'sony' ],
		[ /lg electronics|\blg\b/, '#a50034', 'LG', 'lg' ],
		[ /\bhtc\b/, '#009bde', 'HTC', 'htc' ],
		[ /blackberry/, '#000000', 'BlackBerry', 'blackberry' ],
		[ /zte|中兴/, '#0068b7', 'ZTE', null ],
		[ /tcl/, '#e60012', 'TCL', null ],
		[ /hisense|海信/, '#009944', 'Hisense', null ],
		[ /skyworth|创维/, '#e60012', 'Skyworth', null ],
		[ /wiko/, '#e60012', 'Wiko', null ],
		[ /intel/, '#0068b5', 'Intel', 'intel' ],
		[ /advanced micro devices|\bamd\b/, '#ed1c24', 'AMD', 'amd' ],
		[ /nvidia/, '#76b900', 'NVIDIA', 'nvidia' ],
		[ /nxp|freescale/, '#00a3e0', 'NXP', 'nxp' ],
		[ /broadcom/, '#cc0000', 'Broadcom', 'broadcom' ],
		[ /mediatek|\bmtk\b/, '#ed6d00', 'MediaTek', 'mediatek' ],
		[ /qualcomm|atheros/, '#3253dc', 'Qualcomm', 'qualcomm' ],
		[ /espressif/, '#e7352c', 'Espressif', 'espressif' ],
		[ /nordic semiconductor/, '#00a9ce', 'Nordic Semiconductor', 'nordicsemiconductor' ],
		[ /raspberry pi/, '#c51a4a', 'Raspberry Pi', 'raspberrypi' ],
		[ /arduino/, '#00979d', 'Arduino', 'arduino' ],
		[ /micro:?bit/, '#00ed00', 'micro:bit', 'microbit' ],
		[ /\bdell\b/, '#007db8', 'Dell', 'dell' ],
		[ /hewlett|\bhp\b/, '#0096d6', 'HP', 'hp' ],
		[ /lenovo|联想/, '#e2231a', 'Lenovo', 'lenovo' ],
		[ /asustek|asus/, '#00539b', 'ASUS', 'asus' ],
		[ /micro-star|\bmsi\b/, '#ff0000', 'MSI', 'msi' ],
		[ /razer/, '#00ff00', 'Razer', 'razer' ],
		[ /supermicro/, '#1f3c88', 'Supermicro', 'supermicro' ],
		[ /gigabyte/, '#0c2c56', 'GIGABYTE', null ],
		[ /fujitsu/, '#e60012', 'Fujitsu', 'fujitsu' ],
		[ /toshiba/, '#ff0000', 'Toshiba', 'toshiba' ],
		[ /panasonic/, '#0041a3', 'Panasonic', 'panasonic' ],
		[ /sharp/, '#e60012', 'Sharp', 'sharp' ],
		[ /kyocera/, '#df0029', 'Kyocera', 'kyocera' ],
		[ /epson/, '#003399', 'Epson', 'epson' ],
		[ /canon/, '#cc0000', 'Canon', null ],
		[ /brother/, '#0060a9', 'Brother', null ],
		[ /xerox/, '#d22030', 'Xerox', null ],
		[ /ricoh/, '#d71920', 'Ricoh', null ],
		[ /lexmark/, '#e60000', 'Lexmark', null ],
		[ /zebra/, '#000000', 'Zebra', null ],
		[ /synology|群晖/, '#0072bc', 'Synology', 'synology' ],
		[ /qnap/, '#0b6fb4', 'QNAP', 'qnap' ],
		[ /asustor/, '#1a4b8c', 'ASUSTOR', null ],
		[ /buffalo/, '#e60012', 'Buffalo', null ],
		[ /terra.?master/, '#0055a5', 'TerraMaster', null ],
		[ /western digital/, '#005195', 'Western Digital', null ],
		[ /seagate/, '#6eb43f', 'Seagate', 'seagate' ],
		[ /netapp/, '#0067c5', 'NetApp', 'netapp' ],
		[ /tp-link|普联/, '#00695c', 'TP-Link', 'tplink' ],
		[ /netgear/, '#5b92e5', 'Netgear', 'netgear' ],
		[ /ubiquiti|unifi/, '#0559c9', 'Ubiquiti', 'ubiquiti' ],
		[ /mikrotik/, '#293b57', 'MikroTik', 'mikrotik' ],
		[ /cisco|meraki/, '#1ba0d7', 'Cisco', 'cisco' ],
		[ /aruba/, '#01a982', 'Aruba', null ],
		[ /linksys/, '#1b61c9', 'Linksys', 'linksys' ],
		[ /d-link|dlink/, '#0066b3', 'D-Link', null ],
		[ /fortinet/, '#ee1c25', 'Fortinet', 'fortinet' ],
		[ /palo alto/, '#fa582d', 'Palo Alto Networks', 'paloaltonetworks' ],
		[ /juniper/, '#84b135', 'Juniper', null ],
		[ /zyxel/, '#00539b', 'ZYXEL', null ],
		[ /sophos/, '#005bb3', 'Sophos', null ],
		[ /check point/, '#ee3124', 'Check Point', null ],
		[ /ruijie|锐捷/, '#0055a5', 'Ruijie', null ],
		[ /\bh3c\b/, '#005bac', 'H3C', null ],
		[ /tenda|腾达/, '#e2231a', 'Tenda', null ],
		[ /totolink/, '#e60012', 'TOTOLINK', null ],
		[ /mercusys|水星/, '#0055a5', 'MERCUSYS', null ],
		[ /avm gmbh|fritz/, '#e2001a', 'AVM', 'avm' ],
		[ /sonos/, '#000000', 'Sonos', 'sonos' ],
		[ /bose/, '#000000', 'Bose', 'bose' ],
		[ /harman|\bjbl\b/, '#ff3300', 'JBL', 'jbl' ],
		[ /denon/, '#000000', 'Denon', 'denon' ],
		[ /yamaha/, '#003399', 'Yamaha', null ],
		[ /sennheiser/, '#000000', 'Sennheiser', 'sennheiser' ],
		[ /audio-technica|audiotechnica/, '#000000', 'Audio-Technica', 'audiotechnica' ],
		[ /philips|signify/, '#0b5ed7', 'Philips', 'philipshue' ],
		[ /tuya|涂鸦/, '#ff4800', 'Tuya', null ],
		[ /aqara|lumi/, '#19b969', 'Aqara', null ],
		[ /sonoff|itead/, '#1a1aff', 'SONOFF', null ],
		[ /shelly/, '#00a3e0', 'Shelly', 'shelly' ],
		[ /ecovacs|科沃斯/, '#00a0e9', 'Ecovacs', 'ecovacs' ],
		[ /irobot/, '#6cb33f', 'iRobot', 'irobot' ],
		[ /roborock|石头/, '#00a3e0', 'Roborock', null ],
		[ /dreame|追觅/, '#00a3e0', 'Dreame', null ],
		[ /switchbot/, '#333333', 'SwitchBot', null ],
		[ /wemo/, '#0079c1', 'WeMo', 'wemo' ],
		[ /belkin/, '#003366', 'Belkin', null ],
		[ /govee/, '#00a3e0', 'Govee', null ],
		[ /nanoleaf/, '#00a3e0', 'Nanoleaf', null ],
		[ /ecobee/, '#00a3e0', 'Ecobee', null ],
		[ /ring llc|\bring\b/, '#1a73e8', 'Ring', 'ring' ],
		[ /arlo/, '#49b48a', 'Arlo', 'arlo' ],
		[ /wyze/, '#00b2e3', 'Wyze', 'wyze' ],
		[ /roku/, '#662d91', 'Roku', 'roku' ],
		[ /hikvision|海康/, '#e60012', 'Hikvision', null ],
		[ /dahua|大华/, '#0057a8', 'Dahua', null ],
		[ /ezviz|萤石/, '#00a0e9', 'EZVIZ', null ],
		[ /reolink/, '#00a0e9', 'Reolink', null ],
		[ /uniview|宇视/, '#0057a8', 'Uniview', null ],
		[ /amcrest/, '#0057a8', 'Amcrest', null ],
		[ /vivotek/, '#0057a8', 'Vivotek', null ],
		[ /axis comm/, '#0066b3', 'Axis', null ],
		[ /avast/, '#ff8800', 'Avast', 'avast' ],
		[ /kaspersky/, '#006782', 'Kaspersky', 'kaspersky' ],
		[ /trend micro|trendmicro/, '#d71920', 'Trend Micro', 'trendmicro' ],
		[ /kingston/, '#c8102e', 'Kingston', 'kingstontechnology' ],
		[ /vestel/, '#e60000', 'Vestel', 'vestel' ],
	],

	_oui: null,   // 由 wifiroam/oui.js 注入（"前缀:厂商;..." 紧凑串，前缀 6/7/9 位）
	_logos: null, // 由 wifiroam/logos.js 注入（slug -> 24x24 单色 path）

	_devices: null, // 由 wifiroam/devices.js 注入（设备型号/类型库）

	/* 厂商名 → 品牌信息 { color, brand, logo }；未收录按名称哈希取色 */
	brandOf: function(name) {
		var s = (name || '').toLowerCase();
		for (var i = 0; i < this._BRANDS.length; i++) {
			var b = this._BRANDS[i];
			if (b[0].test(s))
				return { color: b[1], brand: b[2], logo: b[3] };
		}
		return { color: this._hashColor(name), brand: name, logo: null };
	},

	useVendorLogos: function(map) {
		if (map) this._logos = map;
	},

	useDevices: function(mod) {
		if (mod) this._devices = mod;
	},

	/* 厂商名 → 24x24 SVG path；未收录返回 null */
	vendorLogo: function(name) {
		if (!this._logos) return null;
		var b = this.brandOf(name);
		return b.logo ? (this._logos[b.logo] || null) : null;
	},

	useOui: function(raw) {
		if (!raw || this._oui) return;
		var map = {};
		var list = raw.split(';');
		for (var i = 0; i < list.length; i++) {
			var p = list[i].indexOf(':');
			if (p > 0) map[list[i].slice(0, p)] = list[i].slice(p + 1);
		}
		this._oui = map;
	},

	/* 名称哈希 → 稳定的品牌色（同厂商永远同色） */
	_hashColor: function(name) {
		var h = 0;
		for (var i = 0; i < name.length; i++)
			h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
		var hue = Math.abs(h) % 360;
		return 'hsl(' + hue + ',62%,42%)';
	},

	/* 按 MAC 查厂商；返回 { name, brand, color, kind, initial, logo } 或 null
	   随机 MAC（本地管理位）不代表真实厂商，单独标记 */
	vendorOf: function(mac) {
		var hex = (mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
		if (hex.length < 12) return null;
		var first = parseInt(hex.slice(0, 2), 16);
		if (first & 0x02)
			return { name: _('Randomized MAC'), color: '#90a4ae',
			         kind: null, initial: '?', random: true };

		/* 前缀长度：MA-S 9 位、MA-M 7 位、MA-L 6 位，长者优先 */
		var name = null;
		if (this._oui) {
			var keys = [ hex.slice(0, 9), hex.slice(0, 7), hex.slice(0, 6) ];
			for (var i = 0; i < keys.length && !name; i++)
				name = this._oui[keys[i]] || null;
		}
		if (!name) return null;

		var b = this.brandOf(name);
		return {
			name: name,
			brand: b.brand,
			color: b.color,
			kind: this.vendorKind(name),
			initial: (b.brand || name).charAt(0).toUpperCase(),
			logo: b.logo && this._logos ? (this._logos[b.logo] || null) : null,
		};
	},

	/* 厂商 + 设备名 → 类别；优先用设备型号/类型库 */
	kindOf: function(vendor, name) {
		if (this._devices) return this._devices.kindFor(vendor, name);
		return this.vendorKind(vendor);
	},

	/* 厂商名 → 设备类别（委托设备型号/类型库） */
	vendorKind: function(name) {
		return this._devices ? this._devices.vendorKind(name) : null;
	},

	statusBar: function(st) {
		var roamOn = st.roam && st.roam.enabled;
		return E('div', { 'class': 'wr-statusbar' }, [
			E('span', { 'class': 'wr-item' }, [ _('Role'), this.roleBadge(st.role) ]),
			E('span', { 'class': 'wr-item' }, [ _('Device'), E('b', {}, st.name || '-') ]),
			E('span', { 'class': 'wr-item' }, [ _('IP'), E('b', {}, st.ip || '-') ]),
			E('span', { 'class': 'wr-item' }, [ _('Member APs'),
				E('b', {}, '%d / %d'.format(st.peers_online || 0, st.peers_total || 0)) ]),
			E('span', { 'class': 'wr-item' }, [ _('Clients'), E('b', {}, '' + (st.clients_total || 0)) ]),
			E('span', { 'class': 'wr-item' }, [ _('Seamless Roaming'),
				E('span', { 'class': 'wr-badge ' + (roamOn ? 'wr-badge-on' : 'wr-badge-off') },
					roamOn ? _('Enabled') : _('Disabled')) ]),
		]);
	},
});
