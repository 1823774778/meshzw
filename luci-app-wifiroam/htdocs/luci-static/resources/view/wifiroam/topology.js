// wifiroam network topology view (TP-Link EasyMesh style vertical tree)
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';
'require wifiroam.oui as oui';
'require wifiroam.logos as logos';
'require wifiroam.devices as devices';

var SVGNS = 'http://www.w3.org/2000/svg';

wr.useOui(oui.data);
wr.useVendorLogos(logos.data);
wr.useDevices(devices);

var LAY = {
	rootY: 100, apY: 306, clY0: 470, clStep: 92,
	laneW: 212, minW: 840,
	clGap: 118, clPerRow: 5   /* 终端并联：横向间距与每行上限 */
};

var EVENT_TEXT = {
	client_join:  _('Client joined'),
	client_leave: _('Client left'),
	roam_move:    _('Roamed'),
	roam_steer:   _('Steering requested'),
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

	load: function() {
		return Promise.all([
			safeCall('topology'),
			safeCall('status'),
			safeCall('roam_log', { limit: 60 }),
			safeCall('appctl_status')
		]);
	},

	fetch: function() {
		// modal 可能被遮罩点击关闭而没走到我们的 handler
		if (this.modalOpen && !document.querySelector('.modal'))
			this.modalOpen = false;

		return this.load().then(L.bind(function(res) {
			this.topo = res[0];
			this.status = res[1];
			this.logs = (res[2] && res[2].events) || [];
			this.appctl = res[3] || null;
			this.redraw();

			// 详情弹窗开着时同步刷新应用区块，让时长随轮询增长
			if (this._appRedraw && document.querySelector('.wr-appctl'))
				this._appRedraw();
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

	/* ---------------------------------------------------------- layout */
	layout: function() {
		var nodes = (this.topo && this.topo.nodes) || [];
		var aps = nodes.filter(function(n) { return n.type === 'ap'; });
		var clients = nodes.filter(function(n) { return n.type === 'client'; });
		var col = this.collapsed;

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
		var W = Math.max(LAY.minW, x);
		var shift = (W - x) / 2;
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
	apIcon: function(g, p, a) {
		var isCap = (a.role === 'cap');
		var w = 48, h = 48, accent = isCap ? '#2e7d32' : '#1565c0';

		[-12, 12].forEach(function(dx) {
			g.appendChild(svg('line', {
				x1: p.x + dx, y1: p.y - h / 2 + 4,
				x2: p.x + dx, y2: p.y - h / 2 - 11,
				stroke: accent, 'stroke-width': 2.4, 'stroke-linecap': 'round'
			}));
			g.appendChild(svg('circle', {
				cx: p.x + dx, cy: p.y - h / 2 - 13, r: 2.6,
				fill: accent, stroke: 'none'
			}));
		});

		g.appendChild(svg('rect', {
			x: p.x - w / 2, y: p.y - h / 2, width: w, height: h, rx: 5,
			fill: isCap ? 'url(#wrGCap)' : 'url(#wrGAp)',
			stroke: accent, 'stroke-width': 1.8, filter: 'url(#wrShadow)'
		}));
		g.appendChild(svg('rect', {
			x: p.x - w / 2 + 2, y: p.y - h / 2 + 2, width: w - 4, height: 13, rx: 4,
			fill: '#ffffff', opacity: '0.55', stroke: 'none'
		}));
		g.appendChild(svg('rect', {
			x: p.x - w / 2 + 7, y: p.y + h / 2 - 6, width: w - 14, height: 2.6, rx: 1.3,
			fill: accent, opacity: '0.35', stroke: 'none'
		}));

		[-1.5, 2.5, 6.5].forEach(function(r) {
			g.appendChild(svg('path', {
				d: 'M ' + (p.x - r) + ' ' + (p.y + 2) +
				   ' A ' + r + ' ' + r + ' 0 0 1 ' + (p.x + r) + ' ' + (p.y + 2),
				fill: 'none', stroke: accent, 'stroke-width': 1.5,
				'stroke-linecap': 'round', opacity: '0.75'
			}));
		});
		g.appendChild(svg('circle', {
			cx: p.x, cy: p.y + 2, r: 1.5, fill: accent, opacity: '0.9', stroke: 'none'
		}));

		['#43a047', '#43a047', '#ffb300'].forEach(function(col, i) {
			g.appendChild(svg('circle', {
				cx: p.x - w / 2 + 10 + i * 6.5, cy: p.y - h / 2 + 8.5, r: 1.7,
				fill: col, stroke: 'none', opacity: '0.9'
			}));
		});

		/* C/S 角徽标固定在左上角（右上角留给重命名小笔） */
		g.appendChild(svg('circle', {
			cx: p.x - w / 2 + 2, cy: p.y - h / 2 + 2, r: 8,
			fill: accent, stroke: '#fff', 'stroke-width': 1.5
		}));
		g.appendChild(svg('text', {
			x: p.x - w / 2 + 2, y: p.y - h / 2 + 5.5,
			style: 'fill:#fff;stroke:none;font-size:9px;font-weight:700'
		}, isCap ? 'C' : 'S'));
	},

	glyph: function(g, x, y, kind) {
		var box = { fill: '#eceff1', stroke: '#546e7a', 'stroke-width': 1.6 };
		var plate = { fill: '#cfd8dc', stroke: '#78909c', 'stroke-width': 1.2 };

		switch (kind) {
		case 'laptop':
			g.appendChild(svg('rect', {
				x: x - 10, y: y - 5, width: 20, height: 12, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': box['stroke-width']
			}));
			g.appendChild(svg('path', {
				d: 'M ' + (x - 13) + ' ' + (y + 9) + ' L ' + (x + 13) + ' ' + (y + 9) +
				   ' L ' + (x + 10) + ' ' + (y + 5) + ' L ' + (x - 10) + ' ' + (y + 5) + ' Z',
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': plate['stroke-width']
			}));
			break;
		case 'phone':
			g.appendChild(svg('rect', {
				x: x - 6.5, y: y - 11, width: 13, height: 22, rx: 3,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(svg('line', {
				x1: x - 2.5, y1: y - 8, x2: x + 2.5, y2: y - 8,
				stroke: '#78909c', 'stroke-width': 1.3
			}));
			g.appendChild(svg('circle', { cx: x, cy: y + 8, r: 1.3, fill: '#78909c', stroke: 'none' }));
			break;
		case 'tablet':
			g.appendChild(svg('rect', {
				x: x - 9, y: y - 11, width: 18, height: 22, rx: 2.5,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(svg('line', {
				x1: x - 4, y1: y + 8, x2: x + 4, y2: y + 8,
				stroke: '#78909c', 'stroke-width': 1.3
			}));
			break;
		case 'tv':
			g.appendChild(svg('rect', {
				x: x - 11, y: y - 9, width: 22, height: 14, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(svg('path', {
				d: 'M ' + (x - 4) + ' ' + (y + 5) + ' L ' + (x + 4) + ' ' + (y + 5) +
				   ' L ' + (x + 6) + ' ' + (y + 9) + ' L ' + (x - 6) + ' ' + (y + 9) + ' Z',
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': plate['stroke-width']
			}));
			break;
		case 'nas':
			[-10, -3, 4].forEach(function(dy) {
				g.appendChild(svg('rect', {
					x: x - 9, y: y + dy, width: 18, height: 6, rx: 1.5,
					fill: box.fill, stroke: box.stroke, 'stroke-width': 1.5
				}));
				g.appendChild(svg('circle', { cx: x + 6, cy: y + dy + 3, r: 1.2, fill: '#43a047', stroke: 'none' }));
			});
			break;
		case 'speaker':
			g.appendChild(svg('rect', {
				x: x - 7, y: y - 10, width: 14, height: 20, rx: 7,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(svg('circle', {
				cx: x, cy: y - 3.5, r: 2.6,
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1
			}));
			g.appendChild(svg('circle', { cx: x, cy: y + 4.5, r: 1.5, fill: '#78909c', stroke: 'none' }));
			break;
		case 'camera':
			g.appendChild(svg('rect', {
				x: x - 9, y: y - 6, width: 18, height: 12, rx: 2.5,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(svg('circle', {
				cx: x + 1, cy: y, r: 3.4,
				fill: 'none', stroke: '#546e7a', 'stroke-width': 1.6
			}));
			g.appendChild(svg('path', {
				d: 'M ' + (x - 9) + ' ' + (y - 6) + ' L ' + (x - 5) + ' ' + (y - 10) +
				   ' L ' + (x + 1) + ' ' + (y - 10) + ' L ' + (x + 4) + ' ' + (y - 6),
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1
			}));
			break;
		case 'printer':
			g.appendChild(svg('rect', {
				x: x - 10, y: y - 2, width: 20, height: 9, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(svg('rect', {
				x: x - 6, y: y - 9, width: 12, height: 7, rx: 1,
				fill: '#fff', stroke: '#78909c', 'stroke-width': 1.3
			}));
			g.appendChild(svg('rect', {
				x: x - 6, y: y + 5, width: 12, height: 6, rx: 1,
				fill: '#fff', stroke: '#78909c', 'stroke-width': 1.3
			}));
			break;
		case 'router':
			g.appendChild(svg('rect', {
				x: x - 10, y: y - 3, width: 20, height: 8, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			[-6, -2, 2, 6].forEach(function(dx) {
				g.appendChild(svg('circle', { cx: x + dx, cy: y + 1, r: 1.2, fill: '#78909c', stroke: 'none' }));
			});
			g.appendChild(svg('line', {
				x1: x - 4, y1: y - 3, x2: x - 7, y2: y - 10,
				stroke: box.stroke, 'stroke-width': 1.5, 'stroke-linecap': 'round'
			}));
			g.appendChild(svg('line', {
				x1: x + 4, y1: y - 3, x2: x + 7, y2: y - 10,
				stroke: box.stroke, 'stroke-width': 1.5, 'stroke-linecap': 'round'
			}));
			break;
		case 'wired':
			g.appendChild(svg('rect', {
				x: x - 8, y: y - 6, width: 16, height: 12, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			[-5, -1, 3, 7].forEach(function(dx) {
				g.appendChild(svg('rect', {
					x: x + dx - 1.5, y: y - 10, width: 3, height: 5, rx: 1,
					fill: plate.fill, stroke: '#90a4ae', 'stroke-width': 0.8
				}));
			});
			break;
		case 'iot':
			g.appendChild(svg('rect', {
				x: x - 7, y: y - 7, width: 14, height: 14, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(svg('rect', {
				x: x - 3, y: y - 3, width: 6, height: 6, rx: 1,
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1
			}));
			[-4, 0, 4].forEach(function(d) {
				g.appendChild(svg('line', {
					x1: x + d, y1: y - 10.5, x2: x + d, y2: y - 7,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
				g.appendChild(svg('line', {
					x1: x + d, y1: y + 7, x2: x + d, y2: y + 10.5,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
				g.appendChild(svg('line', {
					x1: x - 10.5, y1: y + d, x2: x - 7, y2: y + d,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
				g.appendChild(svg('line', {
					x1: x + 7, y1: y + d, x2: x + 10.5, y2: y + d,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
			});
			break;
		default:
			g.appendChild(svg('circle', {
				cx: x, cy: y - 4, r: 3.2,
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1.2
			}));
			g.appendChild(svg('path', {
				d: 'M ' + (x - 7) + ' ' + (y + 9) + ' Q ' + x + ' ' + (y - 1) + ' ' + (x + 7) + ' ' + (y + 9),
				fill: 'none', stroke: '#546e7a', 'stroke-width': 1.6, 'stroke-linecap': 'round'
			}));
		}
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

		var root = svg('svg', {
			viewBox: '0 0 ' + lay.W + ' ' + lay.H,
			preserveAspectRatio: 'xMidYMin meet',
			width: '100%'
		});
		root.style.height = 'auto';

		/* defs：渐变 + 阴影 */
		var defs = svg('defs');
		defs.innerHTML =
			'<linearGradient id="wrGAp" x1="0" y1="0" x2="0" y2="1">' +
				'<stop offset="0%" stop-color="#ffffff"/>' +
				'<stop offset="100%" stop-color="#e3edfb"/>' +
			'</linearGradient>' +
			'<linearGradient id="wrGCap" x1="0" y1="0" x2="0" y2="1">' +
				'<stop offset="0%" stop-color="#ffffff"/>' +
				'<stop offset="100%" stop-color="#dff2e3"/>' +
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
				/* 水平干线避开 CAP 名称与收展按钮（按钮占 rp.y+67~81），
				   落在按钮下方、终端总线上方的干净区域 */
				var bhY = rp.y + 94 + lvl * 14;
				var d = 'M ' + rp.x + ' ' + (rp.y + 24) +
				        ' L ' + rp.x + ' ' + bhY +
				        ' L ' + sp.x + ' ' + bhY +
				        ' L ' + sp.x + ' ' + (sp.y - 24);
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

				var linkTop = pp.y + 78, linkBot = LAY.clY0 - 18;
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
						x1: cp.x, y1: busY, x2: cp.x, y2: cp.y - 18,
						'class': cls
					}));
				});
			});
		}

		/* AP 节点 */
		function apNode(a) {
			var p = pos[a.id];
			if (!p) return null;
			var g = svg('g', { 'class': 'wr-node wr-ap', 'data-id': a.id });
			self.apIcon(g, p, a);

			label(g, p.x, p.y + 44, a.name || a.mac || a.id, 'wr-label', 168);
			if (a.ip)
				label(g, p.x, p.y + 60, a.ip, 'wr-sub', 168);

			self.pencilButton(g, p.x + 24, p.y - 24, a);

			var kids = (lay.byParent[a.id] || []).length;
			if (kids > 0)
				self.toggleButton(g, p.x, p.y + 74, a.id, kids);

			g.addEventListener('click', function() { self.openDetail(a); });
			return g;
		}

		/* 终端节点 */
		function clientNode(c) {
			var p = pos[c.id];
			if (!p) return null;
			var g = svg('g', { 'class': 'wr-node wr-client', 'data-id': c.id });
			var wifi = c.conn && c.conn.type === 'wifi';

			g.appendChild(svg('rect', {
				x: p.x - 17, y: p.y - 17, width: 34, height: 34, rx: 5,
				fill: '#ffffff',
				stroke: wifi ? signalColor(c.conn.rssi) : '#cfd8dc',
				'stroke-width': 2, filter: 'url(#wrShadow)'
			}));
			self.glyph(g, p.x, p.y, deviceKind(c));
			if (wifi)
				self.sigBars(g, p.x + 24, p.y - 9, c.conn.rssi);

			/* 厂商徽标：按 MAC OUI 识别，品牌色圆点 + 厂商 logo（未收录品牌用首字母） */
			var v = wr.vendorOf(c.mac);
			if (v) {
				g.appendChild(svg('circle', {
					cx: p.x + 15, cy: p.y + 14, r: 7.5,
					fill: v.color, stroke: '#fff', 'stroke-width': 1.2
				}));
				if (v.logo) {
					/* 24x24 的 path 缩放为 9px，居中叠在 15px 圆点上 */
					g.appendChild(svg('path', {
						d: v.logo, fill: '#fff',
						transform: 'translate(' + (p.x + 10.5) + ' ' + (p.y + 9.5) + ') scale(0.375)'
					}));
				}
				else {
					g.appendChild(svg('text', {
						x: p.x + 15, y: p.y + 17.5,
						style: 'fill:#fff;stroke:none;font-size:8px;font-weight:700;text-anchor:middle'
					}, v.initial));
				}
			}

			label(g, p.x, p.y + 35, c.name || c.mac || c.id, 'wr-label', 104);

			var sub = wifi ? wr.rssiText(c.conn.rssi)
			               : ((c.conn && c.conn.port) || c.ip || '');
			if (sub)
				label(g, p.x, p.y + 49, sub, 'wr-sub', 104);

			self.pencilButton(g, p.x + 17, p.y - 17, c);

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

		var sb = document.getElementById('wr-status');
		if (sb && this.status) dom.content(sb, wr.statusBar(this.status));

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
				E('td', { style: 'white-space:nowrap;color:#90a4ae' }, t),
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
			click: function() { self.modalOpen = false; ui.hideModal(); }
		}, _('Cancel'));

		var save = E('button', {
			'class': 'btn cbi-button-positive',
			click: function() {
				return wr.call('set_alias', {
					mac: n.mac, name: input.value.trim()
				}).then(function(res) {
					self.modalOpen = false;
					ui.hideModal();
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
			dlg.addEventListener('hide', function() { self.modalOpen = false; });
	},

	/* 打赏入口弹窗：微信支付二维码 + 联系方式 */
	openDonate: function() {
		var self = this;
		this.modalOpen = true;

		ui.showModal('用得爽，打个赏', [
			E('div', { 'class': 'wr-donate-body' }, [
				E('img', { src: L.resource('wifiroam/donate-qr.png'), alt: 'donate qr' }),
				E('p', {}, '感谢您的认可，打赏用户有任何需求可发送至邮箱 475662846@qq.com')
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					click: function() { self.modalOpen = false; ui.hideModal(); }
				}, '关闭')
			])
		]);

		var dlg = document.querySelector('.modal');
		if (dlg)
			dlg.addEventListener('hide', function() { self.modalOpen = false; });
	},

	/* ---------------------------------------- 上网统计（页签 + 柱状图） */
	dayStr: function(offset) {
		var base = (this.appctl && this.appctl.day)
			? new Date(this.appctl.day + 'T00:00:00') : new Date();
		var d = new Date(base.getTime() - offset * 86400000);
		var p = function(x) { return (x < 10 ? '0' : '') + x; };
		return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
	},

	statsBox: function(n) {
		var self = this;
		var mac = (n.mac || '').toLowerCase().replace(/[^0-9a-f]/g, '');
		var box = E('div', { 'class': 'wr-stats' });

		function onlineDays() {
			var ac = self.appctl;
			return (ac && ac.online && ac.online[mac]) || {};
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
			var tabs = E('div', { 'class': 'wr-tabs' },
				[ ['yesterday', _('Yesterday')], ['today', _('Today')],
				  ['week', _('Last 7 days')] ].map(function(t) {
					return E('button', {
						'class': 'wr-tab' + (p === t[0] ? ' active' : ''),
						click: function() {
							self._statsPeriod = t[0];
							render();
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

			dom.content(box, [
				E('div', { 'class': 'wr-stats-head' }, [
					E('b', {}, _('Usage stats')), tabs
				]),
				E('div', { 'class': 'wr-dev-online wr-stats-online' }, [
					E('div', {}, [
						E('div', { 'class': 'wr-cap' }, _('Online time')),
						E('div', { 'class': 'wr-big' }, wr.fmtDur(periodSec()))
					]),
					E('div', {}, [
						E('div', { 'class': 'wr-cap' }, _('Traffic')),
						E('div', { 'class': 'wr-big' }, wr.fmtBytes(periodBytes()))
					])
				]),
				chart
			]);
		}

		self._statsRedraw = render;
		render();
		return box;
	},

	/* ---------------------------------------- 应用使用时长与访问控制 */
	refreshAppctl: function() {
		return safeCall('appctl_status').then(L.bind(function(res) {
			if (res) this.appctl = res;
			return res;
		}, this));
	},

	appctlBox: function(n) {
		var self = this;
		var box = E('div', { 'class': 'wr-appctl' });

		function render() {
			// 用户正在操作下拉框 / 开关时不打断
			if (document.activeElement && box.contains(document.activeElement))
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
					change: function(ev) {
						var on = ev.target.checked;
						ev.target.disabled = true;
						wr.call('set_appctl', { enabled: on, enhanced: ac.enhanced === true }).then(function(res) {
							if (res && res.ok) {
								wr.notify('success', on ? _('Enabled') : _('Disabled'));
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
				});
				/* E() 会把 checked:false 写成 checked="false"，浏览器仍视为勾选 */
				enableCb.checked = !!ac.enabled;
			}

			var head = E('div', { 'class': 'wr-appctl-head' }, [
				E('b', {}, _('App Usage & Access Control')),
				enableCb
					? E('label', { 'class': 'wr-appctl-switch' }, [
						enableCb, ' ' + _('Enable')
					])
					: null
			]);

			if (!ac || !ac.ok) {
				dom.content(box, [
					head,
					E('div', { 'class': 'wr-muted', style: 'margin-top:0.5em' },
						(ac && ac.error === 'not_cap')
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
			children.push(list);
			children.push(E('div', { 'class': 'wr-appctl-tip' },
				_('Identified by DNS lookups; encrypted DNS may bypass detection.')));

			dom.content(box, children);
		}

		self._appRedraw = render;
		render();
		return box;
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
				click: function() { self.modalOpen = false; ui.hideModal(); }
			}, _('Close')) ];
		} else {
			/* 终端详情：TP-Link 风格 —— 图标+大名称头部、灰色信息行、
			   上下行速率行、在线时间大数字、应用时长列表 */
			var now = Math.floor(Date.now() / 1000);
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
							self.modalOpen = false;
							ui.hideModal();
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
				wifi ? E('div', { 'class': 'wr-dev-rates' }, [
					/* 设备视角实时速率：↑发送=终端→AP，↓接收=AP→终端；
					   span 引用存下来，轮询时随最新拓扑数据刷新（见 _ratesRedraw） */
					upSpan, downSpan
				]) : null,
				self.statsBox(n),
				self.appctlBox(n)
			]);
			btns = [ E('button', {
				'class': 'btn',
				click: function() { self.modalOpen = false; ui.hideModal(); }
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
			});
	},

	/* ---------------------------------------------------------- render */
	render: function(data) {
		this.topo = data[0];
		this.status = data[1];
		this.logs = (data[2] && data[2].events) || [];
		this.appctl = data[3] || null;
		this.logFilter = this.logFilter || { type: '', name: '', mac: '', info: '' };

		poll.add(L.bind(this.fetch, this), 15);

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

		return E('div', {}, [
			wr.css(),
			wr.navTabs('topology'),
			E('h2', {}, [
				_('网络拓扑'),
				E('a', {
					'class': 'wr-donate-btn',
					click: L.bind(this.openDonate, this)
				}, '用得爽，打个赏')
			]),
			E('div', { id: 'wr-status' }, wr.statusBar(this.status || {})),
			hint,
			failed,
			E('div', { 'class': 'wr-toolbar' }, [
				E('button', {
					'class': 'btn',
					click: L.bind(function(ev) { this.refresh(ev.currentTarget); }, this)
				}, _('Refresh')),
				E('span', { id: 'wr-refresh-ts', 'class': 'wr-hint' },
					_('Updated') + ' ' + wr.fmtTime(Math.floor(Date.now() / 1000)))
			]),
			E('div', { 'class': 'wr-topo-wrap', id: 'wr-topo' }),
			E('div', { 'class': 'wr-legend' }, [
				E('span', { 'class': 'wr-lg-wired' }, _('Wired backhaul')),
				E('span', { 'class': 'wr-lg-wifi' }, _('Wireless link')),
				E('span', { 'class': 'wr-lg-good' }, _('Signal good')),
				E('span', { 'class': 'wr-lg-mid' }, _('Signal fair')),
				E('span', { 'class': 'wr-lg-bad' }, _('Signal weak'))
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
