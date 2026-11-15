// wifiroam network topology view (TP-Link EasyMesh style vertical tree)
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require rpc';
'require wifiroam.common as wr';
'require wifiroam.oui as oui';
'require wifiroam.logos as logos';
'require wifiroam.devices as devices';
'require wifiroam.modelart as modelart';
'require wifiroam.glyphs as glyphs';

var SVGNS = 'http://www.w3.org/2000/svg';

wr.useOui(oui.data);
wr.useVendorLogos(logos.data);
wr.useDevices(devices);

var LAY = {
	rootY: 100, apY: 306, clY0: 470, clStep: 104,
	laneW: 212, minW: 840, margin: 18,
	clGap: 118, clPerRow: 5   /* 终端并联：横向间距与每行上限 */
};

/* 布局主题：cap/ap 渐变、AP 卡片/图标、终端卡片/徽标 */
var THEMES = {
	classic: {
		label: _('Classic'), ap: 'icon', client: 'card', linkTop: 86,
		apG: ['#ffffff', '#e3edfb'], capG: ['#ffffff', '#dff2e3'],
		apStroke: '#1565c0', capStroke: '#2e7d32'
	},
	map: {
		label: _('Map'), ap: 'card', client: 'badge', linkTop: 52,
		apG: ['#ffffff', '#f8fafc'], capG: ['#ffffff', '#f6f2ff'],
		apStroke: '#3f9e8a', capStroke: '#7a5cf0'
	},
	minimal: {
		label: _('Minimal'), ap: 'icon', client: 'card', linkTop: 86,
		apG: ['#ffffff', '#ffffff'], capG: ['#ffffff', '#ffffff'],
		apStroke: '#b0bec5', capStroke: '#90a4ae',
		flat: true
	}
};

var THEME_IDS = [ 'classic', 'map', 'minimal' ];

var ROUTER_ART = [
	{ name: 'Super Gateway S20P', re: /s20p|super\s*gateway/i,
	  body: '#37474f', edge: '#263238', panel: '#51646e', ants: 4,
	  tower: false, led: '#4fc3f7', ledN: 4 },
	{ name: 'JDCloud RE-CS-02', re: /re[-_\s]?cs[-_\s]?02/i,
	  body: '#ffffff', edge: '#9fb0c2', panel: '#dde6f0', ants: 2,
	  tower: true, led: '#e1251b', ledN: 1 },
	{ name: 'JDCloud RE-SS-01', re: /re[-_\s]?ss[-_\s]?01/i,
	  body: '#ffffff', edge: '#9fb0c2', panel: '#dde6f0', ants: 0,
	  tower: false, led: '#34a853', ledN: 1 }
];
var ROUTER_ART_FALLBACK = {
	name: '', body: '#ffffff', edge: '#b0bec5', panel: '#eceff1',
	ants: 2, tower: false, led: '#4fc3f7', ledN: 2
};

function routerArtSpec(model) {
	var m = String(model || '');
	for (var i = 0; i < ROUTER_ART.length; i++)
		if (ROUTER_ART[i].re.test(m)) return ROUTER_ART[i];
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
	client_join:  _('Client joined'),
	client_leave: _('Client left'),
	roam_move:    _('Roamed'),
	roam_steer:   _('Steering requested'),
	roam_kick:    _('Forced reconnect'),
	pin_kick:     _('Pinned AP enforced'),
	ap_online:    _('AP online'),
	ap_offline:   _('AP offline'),
	paired:       _('Paired'),
	unpaired:     _('Unpaired'),
	roam_apply:   _('Roaming applied'),
	backhaul_apply: _('Backhaul applied'),
	backhaul_link:  _('Backhaul link changed'),
	cap_connected:_('Connected to main AP'),
	peer_event:   _('Peer event')
};

/* ---------------------------------------------------------------- svg utils */
function svg(tag, attrs, text) {
	var n = document.createElementNS(SVGNS, tag);
	if (attrs) {
		Object.keys(attrs).forEach(function(k) {
			if (attrs[k] != null)
				n.setAttribute(k, attrs[k]);
		});
	}
	if (text != null)
		n.textContent = text;
	return n;
}

/* 按设备名/主机名与厂商归类推断设备类型，用于挑选图标；
   线索都缺失时按连接方式兜底（有线/通用） */
function deviceKind(n) {
	var c = n.conn || {};
	var v = wr.vendorOf(n.mac);
	var kind = wr.kindOf(v && v.name, ((n.name || '') + ' ' + (n.hostname || '')));

	if (kind) return kind;
	if (c.type !== 'wifi') return 'wired';
	return 'generic';
}

/* 粗略估算文本宽度（12.5px 字号；CJK 按全角计），用于判断是否需要滚动 */
function estTextWidth(s) {
	var w = 0;
	for (var i = 0; i < s.length; i++)
		w += (s.charCodeAt(i) > 0x2e80) ? 12.5 : 6.6;
	return w;
}

function signalColor(rssi) {
	if (rssi == null) return '#cfd8dc';
	if (rssi >= -60) return '#43a047';
	if (rssi >= -72) return '#fb8c00';
	return '#e53935';
}

function safeCall(method, args) {
	return wr.call(method, args).catch(function() { return null; });
}

/* 应用小图标：使用各应用官方的真实品牌图标（官网 favicon 的 64px 版本），
   随包内置在 luci-static/resources/wifiroam/apps/，不依赖外网，离线可用 */
var APP_ICONS = {
	wechat:        'wechat',
	qq:            'qq',
	douyin:        'douyin',
	kuaishou:      'kuaishou',
	bilibili:      'bilibili',
	xiaohongshu:   'xiaohongshu',
	weibo:         'weibo',
	taobao:        'taobao',
	iqiyi:         'iqiyi',
	netease_music: 'netease_music',
	youku:         'youku',
	mgtv:          'mgtv',
	zhihu:         'zhihu',
	toutiao:       'toutiao',
	xigua:         'xigua',
	jd:            'jd',
	pinduoduo:     'pinduoduo',
	meituan:       'meituan',
	eleme:         'eleme',
	dingtalk:      'dingtalk',
	baidu:         'baidu',
	ximalaya:      'ximalaya',
	huya:          'huya',
	douyu:         'douyu',
	mihoyo:        'mihoyo',
	kugou:         'kugou'
};

/* 应用类别（与后端 APP_DEFS.cat 对应）：列表按类别分组，对齐 TP-Link */
var CAT_ORDER = [ 'video', 'live', 'social', 'shop', 'music', 'news', 'office', 'game', 'web' ];
var CAT_NAME = {
	video:  _('Video'),
	live:   _('Live'),
	social: _('Social'),
	shop:   _('Shopping'),
	music:  _('Music'),
	news:   _('News'),
	office: _('Office'),
	game:   _('Games'),
	web:    _('Web')
};

function appIcon(id) {
	var file = APP_ICONS[id];
	if (!file) return null;

	return E('img', {
		'class': 'wr-app-ico',
		src: L.resource('wifiroam/apps/' + file + '.png'),
		alt: '', 'aria-hidden': 'true',
		/* 内联写死尺寸与行内显示，避免主题 img 样式或旧 CSS 缓存把它们变成块级元素 */
		style: 'width:18px;height:18px;border-radius:4px;object-fit:contain;' +
		       'flex:0 0 18px;display:inline-block;vertical-align:middle'
	});
}

/* 图标、在线圆点、名称排成一行（水平 flex，禁止上下堆叠） */
function appCell(id, name, live) {
	return E('div', {
		'class': 'wr-app-cell',
		style: 'display:flex;align-items:center;gap:0.45em;white-space:nowrap'
	}, [
		appIcon(id),
		live ? E('span', {
			'class': 'wr-app-live', title: _('In use'),
			style: 'flex:0 0 7px'
		}) : null,
		E('span', { 'class': 'wr-app-name', style: 'line-height:1.35' }, name)
	]);
}

return view.extend({
	topo: null,
	status: null,
	logs: [],
	modalOpen: false,
	collapsed: {},
	zoom: 1,
	search: '',
	themeId: null,

	load: function() {
		return Promise.all([
			safeCall('topology'),
			safeCall('status'),
			safeCall('roam_log', { limit: 60 }),
			safeCall('usage_stats')
		]);
	},

	fetch: function() {
		if (this.modalOpen && !document.body.classList.contains('modal-overlay-active')) {
			this.modalOpen = false;
			this._ratesRedraw = null;
			this._statsRedraw = null;
		}

		return this.load().then(L.bind(function(res) {
			this.topo = res[0];
			this.status = res[1];
			this.logs = (res[2] && res[2].events) || [];
			this.usage = res[3] || null;
			this.redraw();
			this.updateSummary();

			/* 应用统计体积较大，只在详情弹窗打开时按需刷新，
			   避免拓扑页每 10s 轮询都拉取全量应用数据 */
			if (this._appRedraw) {
				this.refreshAppctl().then(L.bind(function() {
					if (this._appRedraw)
						this._appRedraw();
				}, this));
			}
			if (this._statsRedraw && document.querySelector('.wr-stats'))
				this._statsRedraw();
			if (this._ratesRedraw && document.querySelector('.wr-dev-rates'))
				this._ratesRedraw();

			var ts = document.getElementById('wr-refresh-ts');
			if (ts)
				ts.textContent = _('Updated') + ' ' +
					wr.fmtTime(Math.floor(Date.now() / 1000));
		}, this));
	},

	/* 手动刷新：按钮忙碌态 + 完成后高亮拓扑块并提示，
	   避免「点了没反应」的感知缺失 */
	refresh: function(btn) {
		var started = Date.now();

		wr.setBusy(btn, true, _('Refreshing...'));

		function done() {
			wr.setBusy(btn, false);

			var box = document.getElementById('wr-topo');
			if (box) {
				box.classList.remove('wr-flash');
				void box.offsetWidth;   /* 强制重排，让动画可重复触发 */
				box.classList.add('wr-flash');
			}

			wr.notify('success', _('Topology refreshed'));
		}

		return this.fetch().then(function() {
			/* 后端很快时留一点最短时长，让忙碌态与高亮可被感知 */
			var wait = 400 - (Date.now() - started);
			return new Promise(function(resolve) {
				window.setTimeout(resolve, wait > 0 ? wait : 0);
			});
		}).then(done).catch(function() {
			wr.setBusy(btn, false);
			wr.notify('danger', _('Refresh failed'));
		});
	},

	/* --------------------------------------------------- overview / tools */
	todayTraffic: function() {
		var u = this.usage;
		if (!u || !u.day || !u.ndata) return null;

		var total = 0, any = false;
		Object.keys(u.ndata).forEach(function(mac) {
			var v = u.ndata[mac] && u.ndata[mac][u.day];
			if (v) { total += +v || 0; any = true; }
		});
		return any ? total : 0;
	},

	updateSummary: function() {
		var box = document.getElementById('wr-topo-summary');
		if (!box) return;

		var nodes = (this.topo && this.topo.nodes) || [];
		var aps = [], clients = [];
		nodes.forEach(function(n) {
			if (n.type === 'ap') aps.push(n);
			else if (n.type === 'client') clients.push(n);
		});

		var online = 0, wifi = 0, wired = 0, paused = 0;
		var selfMn = this.topo && this.topo.self;
		aps.forEach(function(a) {
			/* 优先用后端 online；兼容旧数据时按 CAP/authed/本机判断 */
			var on = (a.online != null) ? a.online
				: (a.role === 'cap' || a.authed || (selfMn && a.id === selfMn));
			if (on) online++;
		});
		clients.forEach(function(c) {
			if (c.conn && c.conn.type === 'wifi') wifi++;
			else wired++;
			if (c.blocked) paused++;
		});

		var traffic = this.todayTraffic();
		var st = this.status || {};

		/* 原状态条字段并入卡片；成员 AP/客户端已有同义统计，不再重复 */
		dom.content(box, wr.statusCards(st, { members: true, clients: true }).concat([
			wr.card(_('APs online'),
				this.topo ? '%d / %d'.format(online, aps.length) : '-'),
			wr.card(_('Clients'),
				this.topo ? String(clients.length) : '-'),
			wr.card(_('Wireless / Wired'),
				this.topo ? ('%d / %d'.format(wifi, wired)) : '-'),
			wr.card(_('Paused'), String(paused), paused ? 'wr-card-warn' : ''),
			wr.card(_('Traffic today'), traffic != null ? wr.fmtBytes(traffic) : '-')
		]));
	},

	matchNode: function(n) {
		if (!this.search) return true;

		var q = this.search;
		var hay = ((n.name || '') + ' ' + (n.mac || '') + ' ' + (n.ip || '') +
			' ' + (n.hostname || '')).toLowerCase();

		return hay.indexOf(q) >= 0;
	},

	collapseAll: function(on) {
		var nodes = (this.topo && this.topo.nodes) || [];
		var col = {};

		if (on)
			nodes.forEach(function(n) {
				if (n.type === 'ap') col[n.id] = true;
			});

		this.collapsed = col;
		this.redraw();
	},

	/* 全部展开/折叠合并为一个按钮：当前全部折叠则展开，否则折叠 */
	allCollapsed: function() {
		var nodes = (this.topo && this.topo.nodes) || [];
		var aps = nodes.filter(function(n) { return n.type === 'ap'; });
		if (!aps.length) return false;
		for (var i = 0; i < aps.length; i++)
			if (!this.collapsed[aps[i].id]) return false;
		return true;
	},

	toggleCollapseAll: function(btn) {
		var on = !this.allCollapsed();
		this.collapseAll(on);
		if (btn)
			btn.textContent = on ? _('Expand all') : _('Collapse all');
	},

	resetZoom: function() {
		this.zoom = 1;
		this.panX = 0;
		this.panY = 0;
		this.applyZoom();
	},

	/* 当前视窗（viewBox）：缩放 + 平移。平移允许少量越界，
	   保证图完整显示时也能上下左右拖动；⟲ 可复位。 */
	viewBox: function(lay, z) {
		var vw = lay.W / z, vh = lay.H / z;
		var rx = Math.max(0, (lay.W - vw) / 2) + vw * 0.35;
		var ry = Math.max(0, (lay.H - vh) / 2) + vh * 0.35;
		var px = Math.max(-rx, Math.min(rx, this.panX || 0));
		var py = Math.max(-ry, Math.min(ry, this.panY || 0));

		this.panX = px;
		this.panY = py;
		this._view = { w: vw, h: vh };

		return {
			x: (lay.W - vw) / 2 + px,
			y: (lay.H - vh) / 2 + py,
			w: vw, h: vh
		};
	},

	/* 鼠标或手指按住画布即可上下左右拖动；超过阈值后抑制节点点击。 */
	enablePan: function(box) {
		if (!box || box._wrPanBound) return;
		box._wrPanBound = true;

		var self = this;
		var sx = 0, sy = 0, px0 = 0, py0 = 0, active = false, moved = false;

		box.addEventListener('pointerdown', function(ev) {
			if (ev.button != null && ev.button !== 0 && ev.pointerType !== 'touch')
				return;
			if (ev.target.closest && ev.target.closest('.wr-pencil, button, a, select'))
				return;

			active = true;
			moved = false;
			sx = ev.clientX; sy = ev.clientY;
			px0 = self.panX || 0; py0 = self.panY || 0;
			box.classList.add('wr-dragging');
		});

		box.addEventListener('pointermove', function(ev) {
			if (!active) return;

			var dx = ev.clientX - sx, dy = ev.clientY - sy;
			if (!moved && Math.abs(dx) + Math.abs(dy) < 5)
				return;

			/* 确认是拖动后再捕获指针，避免影响普通点击/节点详情 */
			if (!moved && box.setPointerCapture) {
				try { box.setPointerCapture(ev.pointerId); } catch (e) {}
			}
			moved = true;

			var vw = (self._view && self._view.w) || 1;
			var vh = (self._view && self._view.h) || 1;
			var kx = vw / Math.max(1, box.clientWidth);
			var ky = vh / Math.max(1, box.clientHeight);

			/* 向右拖 → 视窗左移；向下拖 → 视窗上移 */
			self.panX = px0 - dx * kx;
			self.panY = py0 - dy * ky;
			self.applyZoom();
		});

		/* 拖动画布后不触发节点详情；下一次正常点击不受影响 */
		box.addEventListener('click', function(ev) {
			if (!moved) return;
			moved = false;
			ev.stopPropagation();
			ev.preventDefault();
		}, true);

		box.addEventListener('dragstart', function(ev) { ev.preventDefault(); });

		function stop(ev) {
			if (!active) return;
			active = false;
			box.classList.remove('wr-dragging');

			if (box.releasePointerCapture && ev && ev.pointerId != null) {
				try { box.releasePointerCapture(ev.pointerId); } catch (e) {}
			}
			if (moved)
				window.setTimeout(function() { moved = false; }, 300);
		}

		box.addEventListener('pointerup', stop);
		box.addEventListener('pointercancel', stop);
	},

	/* ---------------------------------------------------------- layout */
	layout: function() {
		var nodes = (this.topo && this.topo.nodes) || [];
		var aps = nodes.filter(function(n) { return n.type === 'ap'; });
		var clients = nodes.filter(function(n) { return n.type === 'client'; });
		var col = this.search ? {} : this.collapsed;

		var root = null;
		aps.forEach(function(a) { if (!root && a.role === 'cap') root = a; });
		if (!root && aps.length) root = aps[0];
		if (!root)
			return { pos: {}, byParent: {}, root: null, saps: [], clients: [],
			         W: LAY.minW, H: 240 };

		var saps = aps.filter(function(a) { return a !== root; });
		saps.sort(function(a, b) { return (a.name || '').localeCompare(b.name || ''); });

		var byParent = {};
		clients.forEach(function(c) {
			(byParent[c.parent] = byParent[c.parent] || []).push(c);
		});
		Object.keys(byParent).forEach(function(k) {
			byParent[k].sort(function(a, b) {
				var aW = (a.conn && a.conn.type === 'wifi') ? 0 : 1;
				var bW = (b.conn && b.conn.type === 'wifi') ? 0 : 1;
				if (aW !== bW) return aW - bW;
				return (a.name || '').localeCompare(b.name || '');
			});
		});

		/* 每个 AP 独占一条垂直车道，车道水平不相交 → 终端组互不侵入；
		   收起的 AP 不分配终端，车道缩至最窄。
		   混合（无线+有线）时 AP 位于车道内「无线占用宽」处，
		   使无线排左、有线排右后，虚实分界正好落在 AP 正下方的干线上 */
		var order = saps.slice();
		order.splice(Math.floor((saps.length + 1) / 2), 0, root);
		var laneInfo = {};
		order.forEach(function(ap) {
			var kids = col[ap.id] ? [] : (byParent[ap.id] || []);
			var wifiN = 0;
			kids.forEach(function(c) {
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
		order.forEach(function(ap) {
			var li = laneInfo[ap.id];
			pos[ap.id] = { x: x + li.left, y: ap === root ? LAY.rootY : LAY.apY };
			x += li.left + li.right;
		});

		/* 不足最小宽度时整体居中 */
		var W = Math.max(LAY.minW, x + 2 * LAY.margin);
		var shift = LAY.margin + (W - 2 * LAY.margin - x) / 2;
		if (shift > 0)
			Object.keys(pos).forEach(function(id) { pos[id].x += shift; });

		/* 终端排列：混合时无线从干线向左排、有线从干线向右排，
		   虚实分界正好对齐干线（x=ax）；单一类型时以 AP 为中心居中并联。
		   超过 clPerRow 个自动换行错层；收起的 AP 不布终端 */
		var maxRows = 1;
		Object.keys(byParent).forEach(function(pid) {
			if (col[pid]) return;
			var list = byParent[pid];
			var ax = pos[pid] ? pos[pid].x : W / 2;

			var wifi = [], wired = [];
			list.forEach(function(c) {
				if (c.conn && c.conn.type === 'wifi') wifi.push(c);
				else wired.push(c);
			});

			if (wifi.length && wired.length) {
				wifi.forEach(function(c, i) {
					var row = Math.floor(i / LAY.clPerRow);
					var cnt = Math.min(LAY.clPerRow, wifi.length - row * LAY.clPerRow);
					var k = i % LAY.clPerRow;
					maxRows = Math.max(maxRows, row + 1);
					pos[c.id] = {
						x: ax - (cnt - k - 0.5) * LAY.clGap,
						y: LAY.clY0 + row * LAY.clStep
					};
				});
				wired.forEach(function(c, i) {
					var row = Math.floor(i / LAY.clPerRow);
					var k = i % LAY.clPerRow;
					maxRows = Math.max(maxRows, row + 1);
					pos[c.id] = {
						x: ax + (k + 0.5) * LAY.clGap,
						y: LAY.clY0 + row * LAY.clStep
					};
				});
				return;
			}

			list.forEach(function(c, i) {
				var row = Math.floor(i / LAY.clPerRow);
				var cnt = Math.min(LAY.clPerRow, list.length - row * LAY.clPerRow);
				var colIdx = i % LAY.clPerRow;
				maxRows = Math.max(maxRows, row + 1);
				pos[c.id] = {
					x: ax + (colIdx - (cnt - 1) / 2) * LAY.clGap,
					y: LAY.clY0 + row * LAY.clStep
				};
			});
		});

		return {
			pos: pos, byParent: byParent, root: root, saps: saps,
			clients: clients, W: W,
			H: LAY.clY0 + (maxRows - 1) * LAY.clStep + 120
		};
	},

	/* ---------------------------------------------------------- icons */
	/* AP 外观：优先用 modelart 内置的实拍图，其次按型号画风格化路由器 */
	routerArt: function(g, cx, cy, k, a, isCap, accent, withBadge) {
		/* 极简主题：不用实拍图，画一个无阴影的单色路由器线稿 */
		var flat = !!(this._theme && this._theme.flat);
		var photo = flat ? null : routerPhoto(a.model);
		if (photo) {
			this.routerPhotoArt(g, cx, cy, k, a, isCap, accent, withBadge, photo);
			return;
		}
		var sp = flat
			? { name: a.model || (isCap ? 'CAP' : 'AP'), body: '#ffffff', edge: '#b0bec5',
			    panel: '#eceff1', ants: 2, tower: false, led: '#b0bec5', ledN: 1 }
			: routerArtSpec(a.model);
		function X(v) { return cx + v * k; }
		function Y(v) { return cy + v * k; }
		function S(v) { return v * k; }
		var sw = Math.max(1, 1.5 * k);
		var art = svg('g', { 'class': 'wr-ap-art' });
		art.appendChild(svg('title', {}, sp.name || a.model || (isCap ? 'CAP' : 'AP')));

		if (sp.ants > 0) {
			var xs = sp.tower ? [ -15, 15 ]
				: sp.ants >= 4 ? [ -20, -13, 13, 20 ] : [ -19, 19 ];
			var tipY = sp.tower ? -19 : -18;
			var baseY = sp.tower ? -8 : 2;
			xs.forEach(function(dx) {
				art.appendChild(svg('line', {
					x1: X(dx), y1: Y(baseY), x2: X(dx), y2: Y(tipY),
					stroke: sp.edge, 'stroke-width': sw, 'stroke-linecap': 'round'
				}));
				art.appendChild(svg('circle', {
					cx: X(dx), cy: Y(tipY), r: S(1.5), fill: sp.edge, stroke: 'none'
				}));
			});
		}

		var bw = sp.tower ? 22 : 38;
		var bh = sp.tower ? 28 : 16;
		var by = sp.tower ? -10 : 1;
		art.appendChild(svg('rect', {
			x: X(-bw / 2), y: Y(by), width: S(bw), height: S(bh),
			rx: S(sp.tower ? 4 : 3), fill: sp.body, stroke: sp.edge,
			'stroke-width': sw, filter: (!flat && k >= 0.85) ? 'url(#wrShadow)' : null
		}));
		art.appendChild(svg('rect', {
			x: X(-bw / 2 + 2), y: Y(by + 2), width: S(bw - 4),
			height: S(sp.tower ? 7 : 4), rx: S(1.6),
			fill: sp.panel, stroke: 'none',
			opacity: sp.body === '#ffffff' ? '0.85' : '0.55'
		}));

		if (!sp.tower) {
			for (var v = 0; v < 3; v++)
				art.appendChild(svg('line', {
					x1: X(-14), y1: Y(by + 7 + v * 3.2),
					x2: X(-5), y2: Y(by + 7 + v * 3.2),
					stroke: sp.edge, 'stroke-width': Math.max(0.9, 1.3 * k),
					'stroke-linecap': 'round', opacity: '0.8'
				}));
		}

		for (var i = 0; i < sp.ledN; i++) {
			var lx = sp.tower ? 0 : 12 - i * 4.5;
			art.appendChild(svg('circle', {
				cx: X(lx), cy: Y(by + bh - 4), r: S(1.4),
				fill: sp.led, stroke: 'none'
			}));
		}

		if (withBadge) {
			art.appendChild(svg('circle', {
				cx: X(-bw / 2 + 2), cy: Y(by + 3), r: S(7.6),
				fill: accent, stroke: '#fff',
				'stroke-width': Math.max(1.2, 1.6 * k)
			}));
			art.appendChild(svg('text', {
				x: X(-bw / 2 + 2), y: Y(by + 3) + S(3.2),
				style: 'fill:#fff;stroke:none;font-size:' +
					Math.max(8, S(9)) + 'px;font-weight:700;text-anchor:middle'
			}, isCap ? 'C' : 'S'));
		}
		g.appendChild(art);
	},

	routerPhotoArt: function(g, cx, cy, k, a, isCap, accent, withBadge, file) {
		var w = 104 * k, h = 56 * k;
		var art = svg('g', { 'class': 'wr-ap-art wr-ap-photo' });
		art.appendChild(svg('title', {}, a.model || (isCap ? 'CAP' : 'AP')));
		art.appendChild(svg('image', {
			href: L.resource(modelart.base + encodeURIComponent(file)),
			x: cx - w / 2, y: cy - h / 2, width: w, height: h,
			preserveAspectRatio: 'xMidYMid meet',
			filter: k >= 0.85 ? 'url(#wrShadow)' : null
		}));
		if (withBadge) {
			var bx = cx - w / 2 + 2, by = cy - h / 2 + 3;
			art.appendChild(svg('circle', {
				cx: bx, cy: by, r: 8 * k, fill: accent,
				stroke: '#fff', 'stroke-width': Math.max(1.2, 1.6 * k)
			}));
			art.appendChild(svg('text', {
				x: bx, y: by + 3.4 * k,
				style: 'fill:#fff;stroke:none;font-size:' +
					Math.max(8, 9 * k) + 'px;font-weight:700;text-anchor:middle'
			}, isCap ? 'C' : 'S'));
		}
		g.appendChild(art);
	},

	apIcon: function(g, p, a, color) {
		var isCap = a.role === 'cap';
		var accent = color || (isCap ? '#2e7d32' : '#1565c0');
		this.routerArt(g, p.x, p.y + 2, 0.92, a, isCap, accent, true);
	},

	glyph: function(g, x, y, kind) {
		return glyphs.draw(g, x, y, kind);
	},

	sigBars: function(g, x, y, rssi) {
		var lvl = (rssi == null) ? 0 : (rssi >= -60 ? 3 : rssi >= -72 ? 2 : 1);
		var col = signalColor(rssi);

		[4, 7, 10].forEach(function(h, i) {
			g.appendChild(svg('rect', {
				x: x + i * 5, y: y - h, width: 3.4, height: h, rx: 1.4,
				fill: (i < lvl) ? col : '#dde3e8', stroke: 'none'
			}));
		});
	},

	/* 节点右上角的小铅笔入口：直接重命名，不进入详情弹窗 */
	pencilButton: function(g, x, y, n) {
		var self = this;
		var pg = svg('g', { 'class': 'wr-pencil' });

		pg.appendChild(svg('rect', {
			x: x - 6.5, y: y - 6.5, width: 13, height: 13, rx: 2,
			fill: '#fff', stroke: '#b0bec5', 'stroke-width': 1.2
		}));
		pg.appendChild(svg('line', {
			x1: x - 2, y1: y + 2, x2: x + 1.6, y2: y - 1.6,
			stroke: '#546e7a', 'stroke-width': 1.8, 'stroke-linecap': 'round'
		}));
		pg.appendChild(svg('path', {
			d: 'M ' + (x - 2.8) + ' ' + (y + 2.8) +
			   ' L ' + (x - 2.3) + ' ' + (y + 1.1) +
			   ' L ' + (x - 1.1) + ' ' + (y + 2.3) + ' Z',
			fill: '#546e7a', stroke: 'none'
		}));
		pg.appendChild(svg('title', {}, _('Rename')));
		pg.addEventListener('click', function(ev) {
			ev.stopPropagation();
			self.openRename(n);
		});
		g.appendChild(pg);
	},

	toggleButton: function(g, x, y, apId, count) {
		var self = this;
		var isCollapsed = !!self.collapsed[apId];
		var tg = svg('g', { 'class': 'wr-toggle', style: 'cursor:pointer' });

		tg.appendChild(svg('circle', {
			cx: x, cy: y, r: 7,
			fill: '#fff', stroke: '#b0bec5', 'stroke-width': 1.2
		}));

		if (isCollapsed) {
			/* + */
			tg.appendChild(svg('line', {
				x1: x - 3, y1: y, x2: x + 3, y2: y,
				stroke: '#546e7a', 'stroke-width': 1.8, 'stroke-linecap': 'round'
			}));
			tg.appendChild(svg('line', {
				x1: x, y1: y - 3, x2: x, y2: y + 3,
				stroke: '#546e7a', 'stroke-width': 1.8, 'stroke-linecap': 'round'
			}));
			/* 数量徽标 */
			tg.appendChild(svg('circle', {
				cx: x + 7, cy: y - 7, r: 6.5,
				fill: '#1565c0', stroke: '#fff', 'stroke-width': 1.2
			}));
			tg.appendChild(svg('text', {
				x: x + 7, y: y - 4.5,
				style: 'fill:#fff;stroke:none;font-size:8px;font-weight:700;text-anchor:middle'
			}, String(count)));
		} else {
			/* − */
			tg.appendChild(svg('line', {
				x1: x - 3, y1: y, x2: x + 3, y2: y,
				stroke: '#546e7a', 'stroke-width': 1.8, 'stroke-linecap': 'round'
			}));
		}

		tg.appendChild(svg('title', {},
			isCollapsed ? _('Expand') : _('Collapse')));
		tg.addEventListener('click', function(ev) {
			ev.stopPropagation();
			self.collapsed[apId] = !self.collapsed[apId];
			self.redraw();
		});
		g.appendChild(tg);
	},

	/* ---------------------------------------------------------- drawing */
	zoomBy: function(factor) {
		var z = (this.zoom || 1) * factor;
		this.zoom = Math.min(3, Math.max(0.5, Math.round(z * 100) / 100));
		this.applyZoom();
	},

	applyZoom: function() {
		var box = document.getElementById('wr-topo');
		var root = box ? box.querySelector('svg') : null;
		var lay = this._lay;
		if (!root || !lay) return;
		var v = this.viewBox(lay, this.zoom || 1);
		root.setAttribute('viewBox',
			v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h);
	},

	redraw: function() {
		var box = document.getElementById('wr-topo');
		if (!box || this.modalOpen) return;

		if (!this.topo) {
			dom.content(box, E('div', { 'class': 'wr-empty' },
				_('Cannot reach wifiroamd. Make sure the service is running.')));
			return;
		}

		var lay = this.layout();
		var pos = lay.pos;
		var self = this;
		this._lay = lay;
		var th = THEMES[this.themeId] || THEMES.map;
		this._theme = th;

		THEME_IDS.forEach(function(id) {
			box.classList.toggle('wr-theme-' + id,
				!!(THEMES[self.themeId] && id === self.themeId));
		});

		var v = this.viewBox(lay, this.zoom || 1);
		var root = svg('svg', {
			viewBox: v.x + ' ' + v.y + ' ' + v.w + ' ' + v.h,
			preserveAspectRatio: 'xMidYMin meet',
			width: '100%', height: '100%'
		});

		/* defs：渐变 + 阴影 */
		var defs = svg('defs');
		defs.innerHTML =
			'<linearGradient id="wrGAp" x1="0" y1="0" x2="0" y2="1">' +
				'<stop offset="0%" stop-color="' + th.apG[0] + '"/>' +
				'<stop offset="100%" stop-color="' + th.apG[1] + '"/>' +
			'</linearGradient>' +
			'<linearGradient id="wrGCap" x1="0" y1="0" x2="0" y2="1">' +
				'<stop offset="0%" stop-color="' + th.capG[0] + '"/>' +
				'<stop offset="100%" stop-color="' + th.capG[1] + '"/>' +
			'</linearGradient>' +
			'<filter id="wrShadow" x="-50%" y="-50%" width="200%" height="200%">' +
				'<feDropShadow dx="0" dy="2" stdDeviation="2.4" flood-color="#1c3b5a" flood-opacity="0.16"/>' +
			'</filter>';
		root.appendChild(defs);

		/* 名称超长时按车道宽度裁剪，双份文字首尾相接在裁剪窗内单向循环滚动，
		   既不压相邻节点，也能连续读完整个名字 */
		var clipSeq = 0;
		function label(g, x, y, str, cls, maxW) {
			var w = estTextWidth(str);
			if (w <= maxW) {
				g.appendChild(svg('text', { x: x, y: y, 'class': cls }, str));
				return;
			}
			/* clip-path 挂在外层 g 上保持裁剪窗固定不动，
			   只平移内部双份文字（clip 若直接挂在 text 上会随 transform 一起移动，
			   导致整条名字甩进相邻节点的车道） */
			var id = 'wrclip' + (++clipSeq);
			var cp = svg('clipPath', { id: id });
			cp.appendChild(svg('rect', {
				x: x - maxW / 2, y: y - 15, width: maxW, height: 20
			}));
			defs.appendChild(cp);
			var win = svg('g', { 'clip-path': 'url(#' + id + ')' });
			var gap = 40;
			var x0 = x - maxW / 2 + w / 2 + 2;  /* 起始时名字开头对齐车道左缘 */
			var anim = svg('g', { 'class': 'wr-scroll-anim' });
			anim.style.setProperty('--wr-shift', '-' + Math.round(w + gap) + 'px');
			anim.style.setProperty('--wr-dur',
				Math.max(6, Math.round((w + gap) / 28)) + 's');
			var t1 = svg('text', { x: x0, y: y, 'class': cls }, str);
			var t2 = svg('text', { x: x0 + w + gap, y: y, 'class': cls }, str);
			t1.appendChild(svg('title', {}, str));
			anim.appendChild(t1);
			anim.appendChild(t2);
			win.appendChild(anim);
			g.appendChild(win);
		}

		if (lay.root) {
			/* AP 间回程：直角 Z 形路径（CAP 底部 → 水平干线 → SAP 顶部），
			   同侧多 SAP 时水平线错层 */
			var sideLvl = { '-1': 0, '1': 0 };
			lay.saps.forEach(function(a) {
				var rp = pos[lay.root.id], sp = pos[a.id];
				if (!rp || !sp) return;
				var dir = sp.x < rp.x ? -1 : 1;
				var lvl = sideLvl[dir]++;
				var startY = rp.y + th.linkTop;
				var bhY = startY + 8 + lvl * 14;
				var d = 'M ' + rp.x + ' ' + startY +
				        ' L ' + rp.x + ' ' + bhY +
				        ' L ' + sp.x + ' ' + bhY +
				        ' L ' + sp.x + ' ' + (sp.y - (th.ap === 'card' ? 48 : 24));
				var wireless = a.uplink && a.uplink.type === 'wireless';
				root.appendChild(svg('path', {
					d: d,
					'class': 'wr-link wr-aplink' + (wireless ? ' wr-wireless' : ''),
					fill: 'none'
				}));
			});

			/* AP -> 终端：干线垂直下来 → 单条水平总线 → 分支。
			   总线左段无线虚线，右段有线实线 */
			Object.keys(lay.byParent).forEach(function(pid) {
				if (self.collapsed[pid]) return;
				var pp = pos[pid];
				if (!pp) return;
				var kids = lay.byParent[pid].filter(function(c) { return pos[c.id]; });
				if (!kids.length) return;

				var wifi = [], wired = [];
				kids.forEach(function(c) {
					if (c.conn && c.conn.type === 'wifi') wifi.push(c);
					else wired.push(c);
				});

				var linkTop = pp.y + th.linkTop, linkBot = LAY.clY0 - 18;
				var busY = Math.round(linkTop + (linkBot - linkTop) * 0.35);
				var hasBoth = wifi.length && wired.length;

				/* 干线：垂直直线 */
				root.appendChild(svg('line', {
					x1: pp.x, y1: linkTop, x2: pp.x, y2: busY,
					'class': 'wr-link wr-clink'
				}));

				/* 总线：混合时在干线（x=pp.x）处分段，
				   左段无线虚线、右段有线实线，分界即干线底端 */
				if (hasBoth) {
					var wMin = Math.min.apply(null, wifi.map(function(c) { return pos[c.id].x; }));
					var eMax = Math.max.apply(null, wired.map(function(c) { return pos[c.id].x; }));
					root.appendChild(svg('line', {
						x1: wMin, y1: busY, x2: pp.x, y2: busY,
						'class': 'wr-link wr-clink wr-wireless'
					}));
					root.appendChild(svg('line', {
						x1: pp.x, y1: busY, x2: eMax, y2: busY,
						'class': 'wr-link wr-clink'
					}));
				} else if (kids.length > 1) {
					var isWifi = !!wifi.length;
					var allXs = kids.map(function(c) { return pos[c.id].x; }).concat([pp.x]);
					root.appendChild(svg('line', {
						x1: Math.min.apply(null, allXs), y1: busY,
						x2: Math.max.apply(null, allXs), y2: busY,
						'class': 'wr-link wr-clink' + (isWifi ? ' wr-wireless' : '')
					}));
				}

				/* 分支线 */
				kids.forEach(function(c) {
					var cp = pos[c.id];
					var cls = 'wr-link wr-clink';
					if (c.conn && c.conn.type === 'wifi') {
						cls += ' wr-wireless';
						if (c.conn.rssi != null)
							cls += ' ' + wr.rssiClass(c.conn.rssi);
					}
					root.appendChild(svg('line', {
						x1: cp.x, y1: busY, x2: cp.x,
						y2: cp.y - (th.client === 'badge' ? 14 : 18),
						'class': cls
					}));
				});
			});
		}

		/* AP 节点 */
		function apNode(a) {
			var p = pos[a.id];
			if (!p) return null;
			var g = svg('g', {
				'class': 'wr-node wr-ap' +
					((self.search && !self.matchNode(a)) ? ' wr-dim' : ''),
				'data-id': a.id
			});
			var isCap = a.role === 'cap';
			var accent = isCap ? th.capStroke : th.apStroke;
			var kids = (lay.byParent[a.id] || []).length;

			if (th.ap === 'card') {
				var w = 138, h = 96;
				g.appendChild(svg('rect', {
					'class': 'wr-ap-box',
					x: p.x - w / 2, y: p.y - h / 2, width: w, height: h, rx: 8,
					fill: isCap ? 'url(#wrGCap)' : 'url(#wrGAp)',
					stroke: accent, 'stroke-width': 1.4
				}));
				self.routerArt(g, p.x, p.y - 25, 0.78, a, isCap, accent, false);
				g.appendChild(svg('circle', {
					cx: p.x - w / 2 + 14, cy: p.y - h / 2 + 14, r: 8,
					fill: accent, stroke: '#fff', 'stroke-width': 1.5
				}));
				g.appendChild(svg('text', {
					x: p.x - w / 2 + 14, y: p.y - h / 2 + 17.5,
					style: 'fill:#fff;stroke:none;font-size:9px;font-weight:700'
				}, isCap ? 'C' : 'S'));
				label(g, p.x, p.y + 9, a.name || a.mac || a.id, 'wr-label', w - 26);
				if (a.ip)
					label(g, p.x, p.y + 26, a.ip, 'wr-sub', w - 26);
				self.pencilButton(g, p.x + w / 2 - 13, p.y - h / 2 + 13, a);
				if (kids > 0)
					self.toggleButton(g, p.x + w / 2 - 13, p.y + h / 2 - 13, a.id, kids);
			}
			else {
				self.apIcon(g, p, a, accent);
				label(g, p.x, p.y + 44, a.name || a.mac || a.id, 'wr-label', 168);
				if (a.ip)
					label(g, p.x, p.y + 60, a.ip, 'wr-sub', 168);
				self.pencilButton(g, p.x + 24, p.y - 24, a);
				if (kids > 0)
					self.toggleButton(g, p.x, p.y + 74, a.id, kids);
			}

			g.addEventListener('click', function() { self.openDetail(a); });
			return g;
		}

		/* 终端节点 */
		function clientNode(c) {
			var p = pos[c.id];
			if (!p) return null;
			var g = svg('g', {
				'class': 'wr-node wr-client' +
					((self.search && !self.matchNode(c)) ? ' wr-dim' : '') +
					(c.blocked ? ' wr-client-blocked' : ''),
				'data-id': c.id
			});
			var wifi = c.conn && c.conn.type === 'wifi';
			var flat = !!th.flat;
			var stroke = c.blocked ? '#e53935'
				: (flat ? '#cfd8dc'
				        : (wifi ? signalColor(c.conn.rssi) : '#cfd8dc'));
			var badge = th.client === 'badge';
			var vx, vy, vr, vfs, textY, subY, pn;

			if (badge) {
				g.appendChild(svg('circle', {
					'class': 'wr-cl-card',
					cx: p.x, cy: p.y, r: 17,
					fill: '#ffffff', stroke: stroke, 'stroke-width': 1.8
				}));
				self.glyph(g, p.x, p.y, deviceKind(c));
				if (wifi) self.sigBars(g, p.x + 21, p.y - 8, c.conn.rssi);
				vx = p.x + 12; vy = p.y + 12; vr = 6.5; vfs = 7;
				textY = p.y + 33; subY = p.y + 47; pn = 14;
			}
			else {
				g.appendChild(svg('rect', {
					'class': 'wr-cl-card',
					x: p.x - 17, y: p.y - 17, width: 34, height: 34, rx: 5,
					fill: '#ffffff', stroke: stroke, 'stroke-width': flat ? 1.3 : 2,
					filter: flat ? null : 'url(#wrShadow)'
				}));
				self.glyph(g, p.x, p.y, deviceKind(c));
				if (wifi) self.sigBars(g, p.x + 24, p.y - 9, c.conn.rssi);
				vx = p.x + 15; vy = p.y + 14; vr = 7.5; vfs = 8;
				textY = p.y + 35; subY = p.y + 49; pn = 17;
			}

			/* 暂停联网角标：红色圆形 + 两条暂停竖线 */
			if (c.blocked) {
				g.appendChild(svg('circle', {
					cx: p.x - 17, cy: p.y - 17, r: 6,
					fill: '#e53935', stroke: '#fff', 'stroke-width': 1.2
				}));
				[-1.7, 1.7].forEach(function(dx) {
					g.appendChild(svg('rect', {
						x: p.x - 17 + dx - 0.8, y: p.y - 20.2,
						width: 1.6, height: 6.4, rx: 0.6,
						fill: '#fff', stroke: 'none'
					}));
				});
			}

			/* 厂商徽标：按 MAC OUI 识别，品牌色圆点 + 厂商 logo（未收录品牌用首字母） */
			var v = wr.vendorOf(c.mac);
			if (v) {
				g.appendChild(svg('circle', {
					cx: vx, cy: vy, r: vr,
					fill: v.color, stroke: '#fff', 'stroke-width': 1.2
				}));
				if (v.logo) {
					g.appendChild(svg('path', {
						d: v.logo, fill: '#fff',
						transform: 'translate(' + (vx - 4.5) + ' ' + (vy - 4.5) + ') scale(0.375)'
					}));
				}
				else {
					g.appendChild(svg('text', {
						x: vx, y: vy + 2.5,
						style: 'fill:#fff;stroke:none;font-size:' + vfs +
							'px;font-weight:700;text-anchor:middle'
					}, v.initial));
				}
			}

			label(g, p.x, textY, c.name || c.mac || c.id, 'wr-label', 104);

			var sub = wifi ? wr.rssiText(c.conn.rssi)
			               : ((c.conn && c.conn.port) || c.ip || '');
			if (sub)
				label(g, p.x, subY, sub, 'wr-sub', 104);

			self.pencilButton(g, p.x + pn, p.y - pn, c);
			g.addEventListener('click', function() { self.openDetail(c); });
			return g;
		}

		if (lay.root) {
			var rn = apNode(lay.root);
			if (rn) root.appendChild(rn);
			lay.saps.forEach(function(a) {
				var n = apNode(a);
				if (n) root.appendChild(n);
			});
			lay.clients.forEach(function(c) {
				if (self.collapsed[c.parent]) return;
				var n = clientNode(c);
				if (n) root.appendChild(n);
			});
		}

		dom.content(box, root);

		this.renderLog();
	},

	/* ---------------------------------------------------------- event log */
	/* 过滤条件挂在实例上，轮询重绘后仍保持；输入框在 render() 里只建一次，
	   不随 renderLog 重建，避免打字时被 15s 轮询打断 */
	clearLogFilter: function() {
		this.logFilter = { type: '', name: '', mac: '', info: '' };
		['wr-flt-name', 'wr-flt-mac', 'wr-flt-info'].forEach(function(id) {
			var el = document.getElementById(id);
			if (el) el.value = '';
		});
		var sel = document.getElementById('wr-flt-type');
		if (sel) sel.value = '';
		this.renderLog();
	},

	renderLog: function() {
		var box = document.getElementById('wr-log');
		if (!box) return;

		var f = this.logFilter || (this.logFilter = { type: '', name: '', mac: '', info: '' });

		/* 类型下拉：按日志中实际出现过的类型刷新选项，仅在集合变化时重建以免打断选择 */
		var types = [];
		(this.logs || []).forEach(function(ev) {
			var label = EVENT_TEXT[ev.type] || ev.type;
			if (label && types.indexOf(label) < 0) types.push(label);
		});
		var sel = document.getElementById('wr-flt-type');
		if (sel && types.join('|') !== this._logTypeSig) {
			this._logTypeSig = types.join('|');
			dom.content(sel, [ E('option', { value: '' }, '全部类型') ].concat(
				types.map(function(t) { return E('option', { value: t }, t); })));
			sel.value = f.type;
		}

		var lc = function(s) { return (s || '').toLowerCase(); };
		var list = (this.logs || []).filter(function(ev) {
			var tlabel = EVENT_TEXT[ev.type] || ev.type || '';
			if (f.type && tlabel !== f.type) return false;
			if (f.name && lc(ev.name).indexOf(lc(f.name)) < 0) return false;
			if (f.mac && lc(ev.mac).indexOf(lc(f.mac)) < 0) return false;
			if (f.info && lc(ev.info).indexOf(lc(f.info)) < 0) return false;
			return true;
		});

		var rows = list.slice()
			.sort(function(a, b) { return (b.ts || 0) - (a.ts || 0); })
			.map(function(ev) {
			var t = wr.fmtTime(ev.ts);
			return E('tr', {}, [
				E('td', { style: 'white-space:nowrap;color:var(--wr-fg-3)' }, t),
				E('td', { style: 'white-space:nowrap' }, EVENT_TEXT[ev.type] || ev.type || '-'),
				E('td', { style: 'white-space:nowrap;max-width:12em;overflow:hidden;text-overflow:ellipsis',
				         title: ev.name || '' }, ev.name || '-'),
				E('td', { style: 'font-family:monospace;font-size:12px' }, ev.mac || '-'),
				E('td', {}, ev.info || '-')
			]);
		});

		if (!rows.length)
			rows = [ E('tr', { 'class': 'tr placeholder' },
				E('td', { colspan: 5 },
					(this.logs || []).length ? '没有匹配过滤条件的事件' : _('No events yet'))) ];

		dom.content(box, E('div', {}, [
			E('div', { 'class': 'wr-log-count' },
				'匹配 ' + list.length + ' / 共 ' + (this.logs || []).length + ' 条'),
			E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', {}, _('Time')),
					E('th', {}, _('Event')),
					E('th', {}, _('Device Name')),
					E('th', {}, _('MAC')),
					E('th', {}, _('Detail'))
				])
			].concat(rows))
		]));
	},

	/* ---------------------------------------------------------- modal */
	closeModal: function() {
		this.modalOpen = false;
		this._ratesRedraw = null;
		this._statsRedraw = null;
		ui.hideModal();
	},

	/* 设备重命名（AP 与终端都支持）：
	   set_alias 在 SAP 上会转发给 CAP，由 CAP 广播别名表 */
	openRename: function(n) {
		var self = this;
		this.modalOpen = true;

		var input = E('input', {
			type: 'text', 'class': 'cbi-input-text',
			value: n.custom_name || '',
			placeholder: _('Custom Name'),
			style: 'width:100%'
		});

		var body = E('div', {}, [
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Custom Name')),
				input,
				E('div', { 'class': 'wr-hint' },
					_('Leave empty to use the detected name.')),
			]),
			E('div', { 'class': 'wr-hint' }, n.mac || '')
		]);

		var cancel = E('button', {
			'class': 'btn',
			click: function() { self.closeModal(); }
		}, _('Cancel'));

		var save = E('button', {
			'class': 'btn cbi-button-positive',
			click: function() {
				return wr.call('set_alias', {
					mac: n.mac, name: input.value.trim()
				}).then(function(res) {
					self.closeModal();
					if (res && res.ok) {
						wr.notify('success', _('Name saved'));
						self.fetch();
					}
					else {
						wr.notify('danger',
							_('Failed') + ': ' + ((res && res.error) || 'unknown'));
					}
				}).catch(function() {
					wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
				});
			}
		}, _('Save Name'));

		ui.showModal(_('Rename') + ' - ' + (n.name || n.mac || n.id), [
			body,
			E('div', { 'class': 'right' }, [ cancel, ' ', save ])
		]);

		window.setTimeout(function() { input.focus(); input.select(); }, 50);

		var dlg = document.querySelector('.modal');
		if (dlg)
			dlg.addEventListener('hide', function() {
				self.modalOpen = false;
				self._ratesRedraw = null;
				self._statsRedraw = null;
			});
	},


	/* ---------------------------------------- 应用使用时长与访问控制 */
	refreshAppctl: function() {
		return safeCall('appctl_status').then((res) => {
			if (typeof res?.ok !== 'boolean') {
				this.appctl = { ok: false, error: 'unreachable' };
				return this.appctl;
			}
			this.appctl = res;
			return res;
		});
	},

	appctlBox: function(n) {
		var self = this;
		var box = E('div', { 'class': 'wr-appctl' });
		let saving = false;
		/* 应用列表默认折叠，点击标题旁按钮展开 */
		let expanded = false;

		function render(force) {
			// 用户正在操作下拉框 / 开关时不打断
			if (saving || (force !== true && box.contains(document.activeElement)))
				return;

			var ac = self.appctl;
			var mac = (n.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
			var dev = (ac && ac.devices && ac.devices[mac]) || null;
			var blocks = (dev && dev.block) || [];
			var stats = (ac && ac.stats && ac.stats[mac]) || {};
			var now = Math.floor(Date.now() / 1000);

			/* 时长/流量跟随上网统计页签：昨日/今日/过去七天 */
			var period = self._statsPeriod || 'today';
			function pDur(st) {
				var ds = st.days || {};
				if (period === 'yesterday') return ds[self.dayStr(1)] || 0;
				if (period === 'week') {
					var s = 0;
					Object.keys(ds).forEach(function(k) { s += ds[k] || 0; });
					return s;
				}
				return st.today || ds[self.dayStr(0)] || 0;
			}
			function pBytes(st) {
				var ds = st.bdays || {};
				if (period === 'yesterday') return ds[self.dayStr(1)] || 0;
				if (period === 'week') {
					var s = 0;
					Object.keys(ds).forEach(function(k) { s += ds[k] || 0; });
					return s;
				}
				return st.btoday || ds[self.dayStr(0)] || 0;
			}

			var enableCb = null;
			if (ac && ac.ok) {
				enableCb = E('input', {
					type: 'checkbox', 'class': 'wr-switch-input',
					change: async function(ev) {
						const toggle = ev.target;
						const on = toggle.checked;
						saving = true;
						toggle.disabled = true;

						let res = await wr.call('set_appctl', { enabled: on, enhanced: ac.enhanced === true })
							.catch(() => null);
						if (res?.ok === true) {
							self.appctl = { ...ac, enabled: res.enabled, enhanced: res.enhanced };
						} else {
							const status = await self.refreshAppctl();
							if (!status) self.appctl = ac;
							// 超时或响应丢失不代表未保存，以重新读取的状态为准。
							if ((res == null || res === 0 || res === 7) && status?.ok && status.enabled === on)
								res = status;
						}

						saving = false;
						toggle.disabled = false;
						render(true);
						if (res?.ok === true) {
							wr.notify('success', res.enabled ? _('Enabled') : _('Disabled'));
						} else {
							let reason = res?.error || _('request rejected');
							if (res?.error === 'not_cap')
								reason = _('Configure app control on the main AP');
							else if (typeof res === 'number' && res !== 0)
								reason = rpc.getStatusText(res);
							wr.notify('danger', _('Failed') + ': ' + reason);
						}
					}
				});
				/* E() 会把 checked:false 写成 checked="false"，浏览器仍视为勾选 */
				enableCb.checked = !!ac.enabled;
			}

			var titleKids = [ E('b', {}, _('App Usage & Access Control')) ];
			if (ac && ac.ok) {
				titleKids.push(E('button', {
					'class': 'btn wr-app-toggle',
					type: 'button',
					click: function() {
						expanded = !expanded;
						render(true);
					}
				}, expanded ? _('Collapse active apps') : _('Show all active apps')));
			}

			var head = E('div', { 'class': 'wr-appctl-head' }, [
				E('div', { 'class': 'wr-appctl-title' }, titleKids),
				enableCb
					? E('label', { 'class': 'wr-appctl-switch' }, [
						enableCb, ' ' + _('Enable')
					])
					: null
			]);

			if (!ac) {
				dom.content(box, [
					head,
					E('div', { 'class': 'wr-muted', style: 'margin-top:0.5em' },
						_('Loading app usage...'))
				]);
				return;
			}

			if (!ac.ok) {
				dom.content(box, [
					head,
					E('div', { 'class': 'wr-muted', style: 'margin-top:0.5em' },
						(ac.error === 'not_cap')
							? _('Configure app control on the main AP')
							: _('Cannot reach wifiroamd'))
				]);
				return;
			}

			/* TP-Link 风格行列表：图标+名称 ｜ 时长/流量 ｜ 访问控制，
			   按应用类别分组；只展示有用量（时长或流量）的应用，
			   已配置管控的保留，便于解除 */
			var list = E('div', { 'class': 'wr-app-rows' });

			var shown = (ac.apps || []).filter(function(a) {
				var st = stats[a.id];
				return (st && (st.total > 0 || st.today > 0 || st.last > 0 ||
					(st.btotal || 0) > 0 || (st.btoday || 0) > 0))
					|| blocks.indexOf(a.id) >= 0;
			});

			var catIdx = function(c) {
				var i = CAT_ORDER.indexOf(c);
				return i < 0 ? CAT_ORDER.length : i;
			};
			shown.sort(function(a, b) {
				var ca = catIdx(a.cat), cb = catIdx(b.cat);
				if (ca !== cb) return ca - cb;
				return pDur(stats[b.id] || {}) - pDur(stats[a.id] || {});
			});

			if (!shown.length)
				list.appendChild(E('div', { 'class': 'wr-muted',
					style: 'padding:0.5em 0' }, _('No app usage yet')));

			var lastCat = null;
			var identified = 0;

			/* 总流量（全部 forward 字节），作为应用流量归一化基准 */
			var nd = (ac.ndata && ac.ndata[mac]) || {};
			var tot = 0;
			if (period === 'yesterday')
				tot = nd[self.dayStr(1)] || 0;
			else if (period === 'week') {
				Object.keys(nd).forEach(function(k) { tot += nd[k] || 0; });
			}
			else
				tot = nd[self.dayStr(0)] || 0;

			/* 归一化：共享 CDN 的 IP 会让多个应用同时命中计数（allow 规则无
			   verdict，同一包可命中多条），Σapps 可能超过总流量；以 total
			   为准按比例收缩，保证 已识别 + 其他 == total */
			var rawSum = 0;
			shown.forEach(function(a) { rawSum += pBytes(stats[a.id] || {}); });
			var scale = (rawSum > tot && rawSum > 0) ? (tot / rawSum) : 1;

			shown.forEach(function(a) {
				var st = stats[a.id] || {};
				var bytes = Math.round(pBytes(st) * scale);
				identified += bytes;
				var blocked = blocks.indexOf(a.id) >= 0;
				var live = st.last && (now - st.last) < 90;

				if (a.cat && a.cat !== lastCat) {
					lastCat = a.cat;
					list.appendChild(E('div', { 'class': 'wr-cat' },
						CAT_NAME[a.cat] || a.cat));
				}

				var ctl;
				if (!ac.enabled) {
					ctl = E('span', { 'class': 'wr-muted' }, '-');
				}
				else {
					ctl = E('select', {
						'class': 'cbi-input-select wr-app-sel',
						change: function(ev) {
							var action = ev.target.value;
							ev.target.disabled = true;
							wr.call('set_app_policy', {
								mac: n.mac, app: a.id, action: action
							}).then(function(res) {
								if (res && res.ok) {
									wr.notify('success', _('Saved'));
									return self.refreshAppctl().then(render);
								}
								ev.target.disabled = false;
								wr.notify('danger', _('Failed') + ': ' +
									((res && res.error) || 'unknown'));
							}).catch(function() {
								ev.target.disabled = false;
								wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
							});
						}
					}, [
						E('option', { value: 'allow' }, _('Allowed')),
						E('option', { value: 'block' }, _('Blocked'))
					]);
					ctl.value = blocked ? 'block' : 'allow';
				}

				list.appendChild(E('div', { 'class': 'wr-app-row' }, [
					appCell(a.id, a.name, live),
					E('div', { 'class': 'wr-app-dur' }, [
						E('span', {}, wr.fmtDur(pDur(st))),
						E('span', { 'class': 'wr-total' }, wr.fmtBytes(bytes))
					]),
					ctl
				]));
			});

			/* 未识别部分 = 终端总流量 - 已识别应用流量（已归一化，不为负）。
			   单独列出来，避免把非应用流量错误地归到某个 App，
			   也让用户直观看到识别覆盖率。 */
			var other = tot - identified;
			if (other >= 1024) {
				list.appendChild(E('div', { 'class': 'wr-app-row wr-app-other' }, [
					E('div', { 'class': 'wr-app-cell' }, [
						E('span', { 'class': 'wr-app-name' }, _('Other apps'))
					]),
					E('div', { 'class': 'wr-app-dur' }, [
						E('span', { 'class': 'wr-muted' }, '-'),
						E('span', { 'class': 'wr-total' }, wr.fmtBytes(other))
					]),
					E('span', { 'class': 'wr-muted' }, '-')
				]));
			}

			var children = [ head ];
			if (!ac.enabled)
				children.push(E('div', { 'class': 'wr-muted', style: 'margin:0.4em 0' },
					_('Turn on app control to collect usage and enforce rules')));
			children.push(E('div', {
				'class': 'wr-app-body' + (expanded ? '' : ' wr-app-body-collapsed')
			}, [
				list,
				E('div', { 'class': 'wr-appctl-tip' },
					_('Identified by DNS lookups; encrypted DNS may bypass detection.'))
			]));

			dom.content(box, children);
		}

		self._appRedraw = render;
		render();

		/* 应用统计按需加载：每次打开详情都刷新一次，失败后也能自动重试 */
		self.refreshAppctl().then(function() {
			if (self._appRedraw)
				self._appRedraw(true);
		});

		return box;
	},

	/* ---------------------------------------- 上网统计（页签 + 柱状图） */
	dayStr: function(offset) {
		var base = (this.usage && this.usage.day)
			? new Date(this.usage.day + 'T00:00:00') : new Date();
		var d = new Date(base.getTime() - offset * 86400000);
		var p = function(x) { return (x < 10 ? '0' : '') + x; };
		return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
	},

	statsBox: function(n) {
		var self = this;
		var mac = (n.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
		var box = E('div', { 'class': 'wr-stats' });

		function onlineDays() {
			var u = self.usage;
			return (u && u.online && u.online[mac]) || {};
		}

		function periodSec() {
			var ds = onlineDays(), p = self._statsPeriod || 'today';
			if (p === 'yesterday') return ds[self.dayStr(1)] || 0;
			if (p === 'week') {
				var s = 0;
				for (var i = 0; i < 7; i++) s += ds[self.dayStr(i)] || 0;
				return s;
			}
			return ds[self.dayStr(0)] || 0;
		}

		/* 终端总流量按天分桶，与在线时长同页签切换 */
		function periodBytes() {
			var u = self.usage;
			var ds = (u && u.ndata && u.ndata[mac]) || {};
			var p = self._statsPeriod || 'today';
			if (p === 'yesterday') return ds[self.dayStr(1)] || 0;
			if (p === 'week') {
				var s = 0;
				for (var i = 0; i < 7; i++) s += ds[self.dayStr(i)] || 0;
				return s;
			}
			return ds[self.dayStr(0)] || 0;
		}

		/* 上行/下行明细：与总流量同周期汇总（新版本开始采集方向） */
		function periodDir() {
			var u = self.usage;
			var ds = (u && u.ndir && u.ndir[mac]) || {};
			var p = self._statsPeriod || 'today';
			var up = 0, down = 0;
			function addDay(key) {
				var e = ds[key];
				if (!e) return;
				up += parseInt(e.u, 10) || 0;
				down += parseInt(e.d, 10) || 0;
			}
			if (p === 'yesterday') addDay(self.dayStr(1));
			else if (p === 'week') {
				for (var i = 0; i < 7; i++) addDay(self.dayStr(i));
			}
			else addDay(self.dayStr(0));
			return { up: up, down: down };
		}

		function render() {
			var p = self._statsPeriod || 'today';
			var tabs = E('div', { 'class': 'wr-tabs' },
				[ ['yesterday', _('Yesterday')], ['today', _('Today')],
				  ['week', _('Last 7 days')] ].map(function(t) {
					return E('button', {
						'class': 'wr-tab' + (p === t[0] ? ' active' : ''),
						click: function() {
							self._statsPeriod = t[0];
							render();
							/* 应用时长/流量与上网统计共用页签周期，联动刷新 */
							if (self._appRedraw) self._appRedraw();
						}
					}, t[1]);
				}));

			/* 7 天柱状图：固定 24 小时满刻度横线，浅蓝柱、今日深色 */
			var ds = onlineDays();
			var chart = svg('svg', { viewBox: '0 0 320 96', 'class': 'wr-chart' });
			[6, 12, 18, 24].forEach(function(h) {
				var y = 76 - h * 70 / 24;
				chart.appendChild(svg('line', {
					x1: 34, y1: y, x2: 320, y2: y,
					stroke: '#eceff1', 'stroke-width': 1
				}));
				chart.appendChild(svg('text', {
					x: 32, y: y + 3, 'text-anchor': 'end'
				}, _('%dh').format(h)));
			});
			var slot = (320 - 34) / 7;
			for (var i = 6; i >= 0; i--) {
				var key = self.dayStr(i);
				var sec = ds[key] || 0;
				var h = Math.max(sec > 0 ? 1.5 : 0, sec * 70 / 86400);
				var cx = 34 + (6 - i) * slot + slot / 2;
				var bar = svg('rect', {
					x: cx - 11, y: 76 - h, width: 22, height: h, rx: 2,
					fill: i === 0 ? '#1e88e5' : '#64b5f6'
				});
				bar.appendChild(svg('title', {},
					key + ' ' + (sec > 0 ? wr.fmtDur(sec) : '0')));
				chart.appendChild(bar);
				chart.appendChild(svg('text', {
					x: cx, y: 90, 'text-anchor': 'middle'
				}, key.slice(5).replace('-', '.')));
			}

			var bytes = periodBytes();
			var dir = periodDir();
			var hasDir = dir.up > 0 || dir.down > 0;

			dom.content(box, [
				E('div', { 'class': 'wr-stats-head' }, [
					E('b', {}, _('Usage stats')), tabs
				]),
				E('div', { 'class': 'wr-dev-online wr-stats-online' }, [
					E('div', {}, [
						E('div', { 'class': 'wr-cap' }, _('Online time')),
						E('div', { 'class': 'wr-big' }, wr.fmtDur(periodSec()))
					]),
					E('div', { 'class': 'wr-stat-tip' }, [
						E('div', { 'class': 'wr-cap' }, _('Traffic')),
						E('div', { 'class': 'wr-big' }, wr.fmtBytes(bytes)),
						E('div', { 'class': 'wr-tip' }, [
							E('div', {}, '↑ ' + _('Send') + ': ' +
								(hasDir ? wr.fmtBytes(dir.up) : '—')),
							E('div', {}, '↓ ' + _('Receive') + ': ' +
								(hasDir ? wr.fmtBytes(dir.down) : '—'))
						])
					])
				]),
				chart
			]);
		}

		self._statsRedraw = render;
		render();
		return box;
	},

	/* 上网时段：设备详情内按终端设置断网时间 */
	scheduleBox: function(n) {
		var self = this;
		var mn = n.id || String(n.mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
		var requestSeq = 0;
		var btn = E('button', { 'class': 'btn cbi-button-positive', disabled: true }, _('Save'));
		var ctl;

		function refresh() {
			var seq = ++requestSeq;
			return wr.safeCall('ban_list').then(function(res) {
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
				(res.items || []).forEach(function(b) {
					var bm = String(b.mac || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
					if (bm === mn) rule = b;
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
			onEnable: function(on) {
				requestSeq++;
				ctl.setBusy(true);
				btn.disabled = true;
				wr.call('set_ban', { enabled: on }).then(function(res) {
					if (res && res.ok)
						wr.notify('success', on ? _('Enabled') : _('Disabled'));
					else
						wr.notify('danger', _('Failed') + ': ' +
							((res && res.error) || 'unknown'));
					return refresh();
				}).catch(function() {
					wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
					return refresh();
				});
			}
		});

		btn.addEventListener('click', function() {
			if (!ctl.read().weekdays.length) {
				wr.notify('danger', _('Select at least one day'));
				return;
			}
			requestSeq++;
			wr.setBusy(btn, true, _('Saving...'));
			ctl.setBusy(true);
			ctl.save({ name: n.name || '' }).then(function(res) {
				wr.setBusy(btn, false);
				if (res && res.ok) wr.notify('success', _('Saved'));
				else
					wr.notify('danger', _('Failed') + ': ' +
						((res && res.error) || 'unknown'));
				return refresh();
			}).catch(function() {
				wr.setBusy(btn, false);
				wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
				return refresh();
			});
		});

		ctl.actions.appendChild(btn);
		ctl.setStatus('', _('Loading...'));
		refresh();
		return ctl.el;
	},

	openDetail: function(n) {
		var self = this;
		this.modalOpen = true;
		this._statsPeriod = 'today';

		var rows = [];
		function row(k, v) {
			rows.push(E('tr', {}, [
				E('td', {}, k),
				E('td', {}, (v == null || v === '') ? '-' : v)
			]));
		}

		if (n.type === 'ap') {
			row(_('Device Name'), n.name);
			row(_('Role'), wr.roleBadge(n.role));
			row(_('Model'), n.model);
			row(_('IP Address'), n.ip);
			row(_('MAC Address'), n.mac);
			row(_('Firmware'), n.firmware);
			row(_('Uptime'), wr.fmtUptime(n.uptime));
			row(_('Backhaul'), n.uplink
				? (n.uplink.type === 'wired' ? _('Wired') : _('Wireless')) +
				  (n.uplink.port ? ' (' + n.uplink.port + ')' : '')
				: '-');
			row(_('Clients'), '' + ((n.clients || []).length));
		}

		var body, btns;

		if (n.type === 'ap') {
			body = E('div', {}, [
				E('table', { 'class': 'table wr-detail-table' }, rows)
			]);
			btns = [ E('button', {
				'class': 'btn',
				click: function() { self.closeModal(); }
			}, _('Close')) ];
		} else {
			/* 终端详情：TP-Link 风格 —— 图标+大名称头部、灰色信息行、
			   上下行速率行、上网统计、应用时长列表 */
			var conn = n.conn || {};
			var wifi = conn.type === 'wifi';
			var vendor = wr.vendorOf(n.mac);

			/* 速率 span：无线终端才创建；引用挂到 _ratesRedraw，
			   每次轮询拿到最新拓扑后原地刷新文本，弹窗不用重开 */
			var upSpan = null, downSpan = null;
			if (wifi) {
				upSpan = E('span', { 'class': 'wr-dev-up', title: _('Real-time send speed') },
					'↑ ' + _('Send') + ' ' + wr.fmtRate(conn.rx_speed));
				downSpan = E('span', { 'class': 'wr-dev-down', title: _('Real-time receive speed') },
					'↓ ' + _('Receive') + ' ' + wr.fmtRate(conn.tx_speed));
				self._ratesRedraw = function() {
					var cur = null;
					((self.topo && self.topo.nodes) || []).forEach(function(x) {
						if (x.mac === n.mac) cur = x;
					});
					if (!cur || !cur.conn) return;
					upSpan.textContent = '↑ ' + _('Send') + ' ' + wr.fmtRate(cur.conn.rx_speed);
					downSpan.textContent = '↓ ' + _('Receive') + ' ' + wr.fmtRate(cur.conn.tx_speed);
				};
			}

			var iconSvg = svg('svg', { width: 46, height: 34, viewBox: '0 0 46 34' });
			var ig = svg('g', {});
			iconSvg.appendChild(ig);
			this.glyph(ig, 23, 15, deviceKind(n));

			var nameInput = E('input', {
				type: 'text', 'class': 'cbi-input-text',
				value: n.custom_name || '',
				placeholder: _('Custom name')
			});
			var nameEditRow = E('div', {
				'class': 'wr-dev-nameedit', style: 'display:none'
			}, [
				nameInput,
				E('button', {
					'class': 'btn cbi-button-positive',
					click: function() {
						return wr.call('set_alias', {
							mac: n.mac, name: nameInput.value
						}).then(function(res) {
							self.closeModal();
							if (res && res.ok) {
								wr.notify('success', _('Name saved'));
								self.fetch();
							} else {
								wr.notify('danger', _('Failed') + ': ' +
									((res && res.error) || 'unknown'));
							}
						}).catch(function() {
							wr.notify('danger',
								_('Failed') + ': ' + _('request rejected'));
						});
					}
				}, _('Save'))
			]);

			var infoLines = [
				E('div', {}, 'IPv4: ' + (n.ip || '-')),
				E('div', {}, 'MAC: ' + (n.mac || '-').toUpperCase()),
				E('div', {}, _('Connection') + ': ' + wr.connText(n.conn) +
					(wifi ? ' · ' + wr.rssiText(conn.rssi) : ''))
			];
			if (vendor && vendor.name)
				infoLines.push(E('div', {}, _('Vendor') + ': ' + vendor.name));
			if (n.note)
				infoLines.push(E('div', {}, _('Note') + ': ' + n.note));

			var blockStatus = E('span', { 'class': 'wr-hint' });
			var blockBtn = null;

			if (n.type === 'client') {
				blockBtn = E('button', {
					'class': 'btn ' + (n.blocked ? 'cbi-button-positive' : 'cbi-button-negative')
				});

				var applyBlockText = function() {
					blockBtn.className = 'btn ' +
						(n.blocked ? 'cbi-button-positive' : 'cbi-button-negative');
					blockBtn.textContent = n.blocked
						? _('Resume internet') : _('Pause internet');
					blockBtn.disabled = !(self.topo &&
						(self.topo.role === 'cap' || self.topo.role === 'sap'));
				};
				applyBlockText();

				blockBtn.addEventListener('click', function() {
					if (!self.topo ||
					    (self.topo.role !== 'cap' && self.topo.role !== 'sap'))
						return;

					var want = !n.blocked;
					blockBtn.disabled = true;
					blockBtn.textContent = want ? _('Pausing...') : _('Resuming...');
					dom.content(blockStatus, wr.inlineStatus('pending',
						want ? _('Pausing...') : _('Resuming...')));

					wr.call('set_client_block', { mac: n.mac, block: want })
						.then(function(res) {
							if (res && res.ok) {
								n.blocked = !!res.blocked;
								applyBlockText();
								dom.content(blockStatus, wr.inlineStatus('ok',
									n.blocked ? _('Internet paused') : _('Internet restored')));
								wr.notify('success', n.blocked
									? _('Internet paused for this client')
									: _('Internet restored for this client'));
								self.updateSummary();
								self.fetch();
							}
							else {
								applyBlockText();
								dom.content(blockStatus, wr.inlineStatus('fail',
									'✗ ' + ((res && res.error) || _('Failed'))));
							}
						})
						.catch(function() {
							applyBlockText();
							dom.content(blockStatus, wr.inlineStatus('fail',
								'✗ ' + _('request rejected')));
						});
				});
			}

			/* 新增功能：固定 AP + 网络唤醒（设备详情内直接操作） */
			var apNodes = ((self.topo && self.topo.nodes) || []).filter(function(x) {
				return x.type === 'ap';
			});
			var pinSel = E('select', { 'class': 'cbi-input-select' }, [
				E('option', { value: '' }, _('Auto (no pin)'))
			]);
			apNodes.forEach(function(a) {
				pinSel.appendChild(E('option', { value: a.id },
					a.name || a.mac || a.id));
			});
			pinSel.value = n.pin || '';

			var pinStatus = E('span', { 'class': 'wr-hint' });
			var pinBtn = E('button', {
				'class': 'btn cbi-button-positive',
				click: function() {
					pinBtn.disabled = true;
					dom.content(pinStatus, wr.inlineStatus('pending', _('Saving...')));
					return wr.call('set_pin', { mac: n.id, ap: pinSel.value })
						.then(function(res) {
							pinBtn.disabled = false;
							if (res && res.ok) {
								n.pin = pinSel.value || null;
								n.pin_name = n.pin
									? (pinSel.options[pinSel.selectedIndex] || {}).text
									: null;
								dom.content(pinStatus, wr.inlineStatus('ok', _('Saved')));
								wr.notify('success', _('Saved'));
								self.fetch();
							}
							else {
								dom.content(pinStatus, wr.inlineStatus('fail',
									'✗ ' + ((res && res.error) || _('Failed'))));
							}
						})
						.catch(function() {
							pinBtn.disabled = false;
							dom.content(pinStatus, wr.inlineStatus('fail',
								'✗ ' + _('request rejected')));
						});
				}
			}, _('Save'));

			var wakeBtn = E('button', {
				'class': 'btn cbi-button-action wr-wake-btn'
			}, _('Wake on LAN'));
			wakeBtn.addEventListener('click', function() {
				wakeBtn.disabled = true;
				wr.call('wake', { mac: n.id }).then(function(res) {
					wakeBtn.disabled = false;
					if (res && res.ok)
						wr.notify('success',
							_('Magic packet sent to %s').format(n.mac || n.id));
					else if (res && res.error === 'already_online')
						wr.notify('info', _('Device is already online'));
					else
						wr.notify('danger', _('Wake failed') +
							(res && res.error ? ': ' + res.error : ''));
				}).catch(function() {
					wakeBtn.disabled = false;
					wr.notify('danger', _('Wake failed') + ': ' + _('request rejected'));
				});
			});

			body = E('div', { 'class': 'wr-dev' }, [
				E('div', { 'class': 'wr-dev-head' }, [
					iconSvg,
					E('div', { 'class': 'wr-dev-title' }, n.name || n.mac),
					E('a', {
						'class': 'wr-dev-edit',
						click: function() {
							nameEditRow.style.display =
								nameEditRow.style.display === 'none' ? 'flex' : 'none';
						}
					}, _('Edit name'))
				]),
				E('div', { 'class': 'wr-dev-info' }, infoLines),
				nameEditRow,
				E('div', { 'class': 'wr-dev-actions' }, [
					E('span', { 'class': 'wr-hint' }, _('Pinned AP') + ':'),
					pinSel, ' ', pinBtn, ' ', pinStatus, ' ',
					blockBtn ? blockBtn : null,
					blockBtn ? ' ' : null,
					wakeBtn,
					blockBtn ? ' ' : null,
					blockBtn ? blockStatus : null
				]),
				wifi ? E('div', { 'class': 'wr-dev-rates' }, [
					/* 设备视角实时速率：↑发送=终端→AP，↓接收=AP→终端；
					   span 引用存下来，轮询时随最新拓扑数据刷新（见 _ratesRedraw） */
					upSpan, downSpan
				]) : null,
				self.statsBox(n),
				self.scheduleBox(n),
				self.appctlBox(n)
			]);
			btns = [ E('button', {
				'class': 'btn',
				click: function() { self.closeModal(); }
			}, _('Close')) ];
		}

		ui.showModal(n.name || n.mac, [
			body,
			E('div', { 'class': 'right' }, btns)
		]);

		var dlg = document.querySelector('.modal');
		if (dlg)
			dlg.addEventListener('hide', function() {
				self.modalOpen = false;
				self._appRedraw = null;
				self._statsRedraw = null;
				self._ratesRedraw = null;
				self._statsRedraw = null;
			});
	},

	/* ---------------------------------------------------------- render */
	render: function(data) {
		this.topo = data[0];
		this.status = data[1];
		this.logs = (data[2] && data[2].events) || [];
		this.usage = data[3] || null;
		this.logFilter = this.logFilter || { type: '', name: '', mac: '', info: '' };

		if (!this.themeId) {
			var saved = null;
			try { saved = window.localStorage.getItem('wr.topo.theme'); } catch (e) {}
			this.themeId = (saved && THEME_IDS.indexOf(saved) >= 0) ? saved : 'map';
		}

		poll.add(L.bind(this.fetch, this), 10);

		var hint = null;
		if (!this.topo)
			hint = E('div', { 'class': 'alert-message warning' },
				_('Cannot reach wifiroamd. Make sure the service is running.'));
		else if (this.topo.role === 'sap')
			hint = E('div', { 'class': 'alert-message warning' },
				_('This device is a sub AP. Visit the main AP to see the full network topology.'));

		var failed = null;
		var la = this.status && this.status.last_apply;
		if (la && la.results) {
			var bad = la.results.filter(function(r) { return r.ok === false; });
			if (bad.length)
				failed = E('div', { 'class': 'alert-message warning' },
					_('Some APs failed to apply roaming config') + ': ' +
					bad.map(function(r) { return r.name || r.ap; }).join(', '));
		}

		function themeSelect(vm) {
			var sel = E('select', {
				'class': 'cbi-input-select wr-theme-sel',
				change: function(ev) {
					var v = ev.target.value;
					if (THEME_IDS.indexOf(v) < 0) return;
					vm.themeId = v;
					try { window.localStorage.setItem('wr.topo.theme', v); } catch (e) {}
					vm.redraw();
				}
			}, THEME_IDS.map(function(id) {
				return E('option', { value: id }, THEMES[id].label);
			}));
			sel.value = vm.themeId;
			return sel;
		}

		var topoBox = E('div', { 'class': 'wr-topo-wrap', id: 'wr-topo' });
		this.enablePan(topoBox);

		window.setTimeout(L.bind(function() {
			this.redraw();
			this.updateSummary();
		}, this), 0);

		return E('div', {}, [
			wr.css(),
			E('h2', {}, _('网络拓扑')),
			E('div', { id: 'wr-topo-summary', 'class': 'wr-cards' }),
			hint,
			failed,
			E('div', { 'class': 'wr-toolbar wr-toolbar-wrap' }, [
				E('input', {
					type: 'text', 'class': 'cbi-input-text wr-search',
					placeholder: _('Search AP / client by name, IP or MAC'),
					input: L.bind(function(ev) {
						this.search = ev.target.value.trim().toLowerCase();
						this.redraw();
					}, this)
				}),
				E('button', {
					'class': 'btn',
					click: L.bind(function(ev) {
						this.toggleCollapseAll(ev.currentTarget);
					}, this)
				}, this.allCollapsed() ? _('Expand all') : _('Collapse all')),
				E('label', { 'class': 'wr-theme-pick' }, [
					E('span', { 'class': 'wr-hint' }, _('Theme')),
					themeSelect(this)
				]),
				E('button', {
					'class': 'btn',
					click: L.bind(function(ev) { this.refresh(ev.currentTarget); }, this)
				}, _('Refresh')),
				E('span', { id: 'wr-refresh-ts', 'class': 'wr-hint' },
					_('Updated') + ' ' + wr.fmtTime(Math.floor(Date.now() / 1000)))
			]),
			E('div', { 'class': 'wr-topo-outer' }, [
				E('div', { 'class': 'wr-zoom' }, [
					E('button', {
						'class': 'btn', type: 'button', title: _('Zoom in'),
						click: L.bind(function() { this.zoomBy(1.25); }, this)
					}, '+'),
					E('button', {
						'class': 'btn', type: 'button', title: _('Zoom out'),
						click: L.bind(function() { this.zoomBy(0.8); }, this)
					}, '−'),
					E('button', {
						'class': 'btn', type: 'button', title: _('Reset zoom'),
						click: L.bind(function() { this.resetZoom(); }, this)
					}, '⟲')
				]),
				topoBox
			]),
			E('div', { 'class': 'wr-legend' }, [
				E('span', { 'class': 'wr-lg-wired' }, _('Wired backhaul')),
				E('span', { 'class': 'wr-lg-wifi' }, _('Wireless link')),
				E('span', { 'class': 'wr-lg-good' }, _('Signal good')),
				E('span', { 'class': 'wr-lg-mid' }, _('Signal fair')),
				E('span', { 'class': 'wr-lg-bad' }, _('Signal weak')),
				E('div', { 'class': 'wr-hint' }, _('Drag or scroll to pan the topology'))
			]),
			E('div', { 'class': 'cbi-section', style: 'margin-top:1em' }, [
				E('h3', {}, _('Roaming Event Log')),
				E('div', { 'class': 'wr-log-filter' }, [
					E('select', {
						id: 'wr-flt-type', 'class': 'cbi-input-select',
						change: L.bind(function(ev) { this.logFilter.type = ev.target.value; this.renderLog(); }, this)
					}, [ E('option', { value: '' }, '全部类型') ]),
					E('input', {
						type: 'text', id: 'wr-flt-name', 'class': 'cbi-input-text',
						placeholder: '设备名称',
						input: L.bind(function(ev) { this.logFilter.name = ev.target.value; this.renderLog(); }, this)
					}),
					E('input', {
						type: 'text', id: 'wr-flt-mac', 'class': 'cbi-input-text',
						placeholder: 'MAC 地址',
						input: L.bind(function(ev) { this.logFilter.mac = ev.target.value; this.renderLog(); }, this)
					}),
					E('input', {
						type: 'text', id: 'wr-flt-info', 'class': 'cbi-input-text',
						placeholder: '详情关键词',
						input: L.bind(function(ev) { this.logFilter.info = ev.target.value; this.renderLog(); }, this)
					}),
					E('button', {
						'class': 'btn', click: L.bind(this.clearLogFilter, this)
					}, '清空')
				]),
				E('div', { id: 'wr-log', 'class': 'wr-log-scroll' })
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
