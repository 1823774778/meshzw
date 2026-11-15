// wifiroam client devices view (r91 layout + history, pinned AP, Wake on LAN)
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';
'require wifiroam.oui as oui';
'require wifiroam.devices as devices';
'require wifiroam.glyphs as glyphs';

wr.useOui(oui.data);
wr.useDevices(devices);

var UI_KEY = 'wr_clients_ui';
var SVGNS = 'http://www.w3.org/2000/svg';

function pencilIcon() {
	var el = document.createElementNS(SVGNS, 'svg');
	el.setAttribute('viewBox', '0 0 24 24');
	el.setAttribute('width', '16');
	el.setAttribute('height', '16');
	el.setAttribute('fill', 'none');
	el.setAttribute('stroke', 'currentColor');
	el.setAttribute('stroke-width', '1.8');
	el.setAttribute('stroke-linecap', 'round');
	el.setAttribute('stroke-linejoin', 'round');
	var p1 = document.createElementNS(SVGNS, 'path');
	p1.setAttribute('d', 'M12 20h9');
	var p2 = document.createElementNS(SVGNS, 'path');
	p2.setAttribute('d', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z');
	el.appendChild(p1);
	el.appendChild(p2);
	return el;
}

function loadUi() {
	try {
		var d = JSON.parse(sessionStorage.getItem(UI_KEY) || '{}');
		return (d && typeof d === 'object') ? d : {};
	} catch (e) { return {}; }
}

function sigLevel(rssi) {
	if (rssi == null) return 0;
	if (rssi >= -55) return 4;
	if (rssi >= -65) return 3;
	if (rssi >= -75) return 2;
	return 1;
}

function signalColor(rssi) {
	if (rssi == null) return '#cfd8dc';
	if (rssi >= -60) return '#43a047';
	if (rssi >= -72) return '#fb8c00';
	return '#e53935';
}

function ipValue(ip) {
	var p = String(ip || '').split('.');
	if (p.length !== 4) return 4294967295;
	var n = 0;
	for (var i = 0; i < 4; i++)
		n = n * 256 + (parseInt(p[i], 10) || 0);
	return n;
}

function errText(e) {
	return {
		unknown_device: _('Device not found in history'),
		already_online: _('Device is already online'),
		send_failed: _('Failed to send magic packet'),
		invalid_mac: _('Invalid MAC address'),
		invalid_ap: _('Invalid AP'),
		unknown_ap: _('Unknown AP'),
		link_down: _('Link to main AP is down'),
		not_cap: _('Only the main AP can pause clients')
	}[e] || e || _('unknown');
}

return view.extend({
	data: null,
	filterAp: '',
	filterText: '',
	filterKind: '',
	sortBy: 'name',
	blocking: {},
	waking: {},
	editing: {},

	load: function() {
		var ui = loadUi();
		this.filterAp = ui.ap || '';
		this.filterText = ui.text || '';
		this.filterKind = ui.kind || '';
		this.sortBy = ui.sort || 'name';

		if (['', 'wifi', 'wired'].indexOf(this.filterKind) < 0)
			this.filterKind = '';
		if (['name', 'ip', 'signal', 'rate', 'online', 'ap'].indexOf(this.sortBy) < 0)
			this.sortBy = 'name';

		return wr.safeCall('device_history');
	},

	saveUi: function() {
		try {
			sessionStorage.setItem(UI_KEY, JSON.stringify({
				ap: this.filterAp, text: this.filterText,
				kind: this.filterKind, sort: this.sortBy
			}));
		} catch (e) { /* private mode */ }
	},

	/* 列表里是否正在输入：有焦点就绝不重建，否则会吞掉用户正在打的字 */
	hasFocusInTable: function() {
		var box = document.getElementById('wr-clients');
		var el = document.activeElement;

		return !!(box && el && box.contains(el) &&
			/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
	},

	refresh: function() {
		return wr.safeCall('device_history').then(L.bind(function(d) {
			if (!d) return;

			this.data = d;

			if (Object.keys(this.blocking).length ||
			    this.hasFocusInTable())
				return;

			this.renderAll();
		}, this));
	},

	clients: function() {
		return (this.data && this.data.devices) || [];
	},

	apNames: function() {
		var map = {};
		((this.data && this.data.aps) || []).forEach(function(a) {
			if (a && a.id) map[a.id] = a.name || a.id;
		});
		return map;
	},

	filtered: function() {
		var fAp = this.filterAp, fText = (this.filterText || '').toLowerCase();
		var fKind = this.filterKind;

		var list = this.clients().filter(function(c) {
			if (fAp && c.ap !== fAp) return false;
			if (fKind && (c.conn && c.conn.type) !== fKind) return false;
			if (fText) {
				var hay = ((c.name || '') + ' ' + (c.ip || '') + ' ' +
					(c.mac || '') + ' ' + (c.hostname || '') + ' ' +
					(c.ap_name || '')).toLowerCase();
				if (hay.indexOf(fText) < 0) return false;
			}
			return true;
		});

		var apNames = this.apNames();
		var sort = this.sortBy;

		list.sort(function(a, b) {
			var av, bv;
			switch (sort) {
			case 'ip':
				return ipValue(a.ip) - ipValue(b.ip);
			case 'signal':
				av = (a.conn && a.conn.rssi != null) ? a.conn.rssi : -999;
				bv = (b.conn && b.conn.rssi != null) ? b.conn.rssi : -999;
				return bv - av;
			case 'rate':
				av = a.conn ? Math.max(a.conn.rx_speed || 0, a.conn.tx_speed || 0) : 0;
				bv = b.conn ? Math.max(b.conn.rx_speed || 0, b.conn.tx_speed || 0) : 0;
				return bv - av;
			case 'online':
				return (a.conn && a.conn.since ? a.conn.since : 0) -
				       (b.conn && b.conn.since ? b.conn.since : 0);
			case 'ap':
				return (apNames[a.ap] || '').localeCompare(apNames[b.ap] || '');
			default:
				return (a.name || '').localeCompare(b.name || '');
			}
		});
		return list;
	},

	summary: function() {
		var list = this.clients();
		var wifi = 0, wired = 0, blocked = 0;

		list.forEach(function(c) {
			if (c.conn && c.conn.type === 'wifi') wifi++;
			else if (c.conn) wired++;
			if (c.blocked) blocked++;
		});

		return { total: list.length, wifi: wifi, wired: wired, blocked: blocked };
	},

	renderSummary: function() {
		var box = document.getElementById('wr-cl-summary');
		if (!box) return;

		var s = this.summary();
		var shown = this.filtered().length;
		var isCap = !!(this.data && this.data.role === 'cap');

		function card(label, value, cls) {
			return E('div', { 'class': 'wr-card' + (cls ? ' ' + cls : '') }, [
				E('div', { 'class': 'wr-card-value' }, String(value)),
				E('div', { 'class': 'wr-card-label' }, label)
			]);
		}

		dom.content(box, [
			card(_('Total clients'), s.total),
			card(_('Wireless'), s.wifi),
			card(_('Wired'), s.wired),
			card(_('Paused'), s.blocked, s.blocked ? 'wr-card-warn' : ''),
			E('div', { 'class': 'wr-card wr-card-note' }, [
				E('div', { 'class': 'wr-card-value' },
					shown === s.total ? _('All') : ('%d / %d'.format(shown, s.total))),
				E('div', { 'class': 'wr-card-label' }, _('Filtered'))
			])
		]);
	},

	renderAll: function() {
		this.renderSummary();
		this.renderCards();
	},


	toggleBlock: function(c, btn) {
		var self = this;

		if (this.blocking[c.mac]) return;

		if (!this.data ||
		    (this.data.role !== 'cap' && this.data.role !== 'sap')) {
			wr.notify('warning', _('Only the main AP can pause clients'));
			return;
		}

		var want = !c.blocked;
		this.blocking[c.mac] = true;
		wr.setBusy(btn, true, want ? _('Pausing...') : _('Resuming...'));

		return wr.call('set_client_block', { mac: c.mac, block: want }).then(function(res) {
			if (res && res.ok) {
				c.blocked = !!res.blocked;
				wr.notify('success', c.blocked
					? _('Internet paused for this client')
					: _('Internet restored for this client'));
			}
			else {
				wr.notify('danger', _('Failed') + ': ' +
					((res && (res.error === 'not_cap'
						? _('Only the main AP can pause clients')
						: errText(res.error))) || 'unknown'));
			}
		}).catch(function() {
			wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
		}).then(function() {
			delete self.blocking[c.mac];
			wr.setBusy(btn, false);
			/* 重新拉取历史：暂停状态已同步到子 AP，页面立即刷新 */
			self.refresh();
		});
	},

	wake: function(c, btn) {
		var self = this;
		if (this.waking[c.id]) return;

		this.waking[c.id] = true;
		wr.setBusy(btn, true, _('Sending...'));

		return wr.call('wake', { mac: c.id }).then(function(res) {
			if (res && res.ok)
				wr.notify('success',
					_('Magic packet sent to %s').format(c.mac || c.id));
			else
				wr.notify('danger', _('Wake failed') +
					(res && res.error ? ': ' + errText(res.error) : ''));
		}).catch(function() {
			wr.notify('danger', _('Wake failed') + ': ' + _('request rejected'));
		}).then(function() {
			delete self.waking[c.id];
			wr.setBusy(btn, false);
		});
	},

	renderCards: function() {
		var box = document.getElementById('wr-clients');
		if (!box || !this.data) return;

		var self = this;
		var apNames = this.apNames();
		var list = this.filtered();
		var now = Math.floor(Date.now() / 1000);

		var cards = list.map(function(c) {
			return self.clientCard(c, apNames, now);
		});

		dom.content(box, cards.length
			? E('div', { 'class': 'wr-dcard-grid' }, cards)
			: E('div', { 'class': 'wr-empty' }, _('No clients found')));

		var cnt = document.getElementById('wr-count');
		if (cnt) {
			var all = this.clients().length;
			cnt.textContent = (list.length === all)
				? _('%d clients').format(all)
				: '%d / %d'.format(list.length, all);
		}
	},

	/* 设备图标：与拓扑节点一致的圆角方块 + 设备 glyph + 厂商徽标 */
	tile: function(c) {
		var v = wr.vendorOf(c.mac);
		var kind = wr.kindOf(v && v.name,
			((c.name || '') + ' ' + (c.hostname || '')));
		if (!kind)
			kind = (c.conn && c.conn.type !== 'wifi') ? 'wired' : 'generic';

		var wifi = c.conn && c.conn.type === 'wifi';
		var stroke = c.blocked ? '#e53935'
			: (wifi ? signalColor(c.conn.rssi) : '#cfd8dc');

		var el = document.createElementNS(SVGNS, 'svg');
		el.setAttribute('viewBox', '0 0 40 40');
		el.setAttribute('width', '40');
		el.setAttribute('height', '40');
		el.setAttribute('class', 'wr-dev-tile');

		var bg = document.createElementNS(SVGNS, 'rect');
		bg.setAttribute('x', '1');
		bg.setAttribute('y', '1');
		bg.setAttribute('width', '38');
		bg.setAttribute('height', '38');
		bg.setAttribute('rx', '10');
		bg.setAttribute('class', 'wr-dev-tile-bg');
		bg.setAttribute('stroke', stroke);
		bg.setAttribute('stroke-width', '2');
		el.appendChild(bg);

		var g = document.createElementNS(SVGNS, 'g');
		glyphs.draw(g, 20, 19, kind);
		el.appendChild(g);

		/* 右下角厂商徽标：品牌色圆形 + logo/首字母，与拓扑一致 */
		if (v) {
			var cx = 31, cy = 31;
			var circle = document.createElementNS(SVGNS, 'circle');
			circle.setAttribute('cx', cx);
			circle.setAttribute('cy', cy);
			circle.setAttribute('r', '6');
			circle.setAttribute('fill', v.color || '#90a4ae');
			circle.setAttribute('stroke', '#fff');
			circle.setAttribute('stroke-width', '1.2');
			el.appendChild(circle);

			if (v.logo) {
				var p = document.createElementNS(SVGNS, 'path');
				p.setAttribute('d', v.logo);
				p.setAttribute('fill', '#fff');
				p.setAttribute('transform',
					'translate(' + (cx - 4.5) + ' ' + (cy - 4.5) + ') scale(0.375)');
				el.appendChild(p);
			}
			else {
				var t = document.createElementNS(SVGNS, 'text');
				t.setAttribute('x', cx);
				t.setAttribute('y', cy + 2.5);
				t.setAttribute('style',
					'fill:#fff;stroke:none;font-size:7px;font-weight:700;text-anchor:middle');
				t.textContent = v.initial || '?';
				el.appendChild(t);
			}
		}

		return el;
	},

	cardRow: function(label, value, extra) {
		return E('div', { 'class': 'wr-dcard-row' }, [
			E('span', { 'class': 'wr-dcard-key' }, label),
			E('span', { 'class': 'wr-dcard-val' }, [ value, extra ])
		]);
	},

	clientCard: function(c, apNames, now) {
		var self = this;
		var online = !!c.online;
		var wifi = c.conn && c.conn.type === 'wifi';
		var conn = c.conn || {};
		var blocked = !!c.blocked;
		var v = wr.vendorOf(c.mac);
		var editing = !!this.editing[c.id];

		/* 图三布局：头像 + 名称 + 在线徽标 + 编辑铅笔 */
		var badge = E('span', {
			'class': 'wr-badge' + (blocked ? '' :
				(online ? ' wr-badge-on' : ' wr-badge-off')),
			style: blocked ? 'background:#c62828' : null
		}, blocked ? _('Paused') : (online ? _('Online') : _('Offline')));

		/* 如果这条记录本身就是主路由/子路由，显示对应身份徽标 */
		var roleBadge = (c.device_role === 'cap' || c.device_role === 'sap')
			? wr.roleBadge(c.device_role) : null;

		var editBtn = E('button', {
			'class': 'wr-dcard-edit-btn',
			title: _('Edit'),
			'aria-label': _('Edit'),
			click: function(ev) {
				ev.stopPropagation();
				self.editing[c.id] = true;
				self.renderCards();
			}
		}, [ pencilIcon() ]);

		/* 图一：点铅笔后在卡片内展开改名 + 固定 AP 编辑框 */
		var editPanel = null;
		if (editing) {
			var nameIn = E('input', {
				type: 'text', 'class': 'cbi-input-text wr-dcard-input',
				value: c.custom_name || '',
				placeholder: c.name || c.mac || ''
			});
			var pinSel = E('select', {
				'class': 'cbi-input-select wr-dcard-pin-sel'
			}, [ E('option', { value: '' }, _('Auto (no pin)')) ]);
			var known = {};
			((self.data && self.data.aps) || []).forEach(function(a) {
				known[a.id] = true;
				pinSel.appendChild(E('option', { value: a.id }, a.name || a.id));
			});
			if (c.pin && !known[c.pin])
				pinSel.appendChild(E('option', { value: c.pin }, c.pin_name || c.pin));
			pinSel.value = c.pin || '';

			var status = E('span', { 'class': 'wr-hint' });
			var saveBtn = E('button', {
				'class': 'btn cbi-button-positive',
				click: function() {
					var name = (nameIn.value || '').trim();
					var pin = pinSel.value || '';
					var nameChanged = (name !== (c.custom_name || ''));
					var jobs = [];

					if (nameChanged)
						jobs.push(wr.call('set_alias', { mac: c.id, name: name }));
					if (pin !== (c.pin || ''))
						jobs.push(wr.call('set_pin', { mac: c.id, ap: pin }));

					if (!jobs.length) {
						delete self.editing[c.id];
						self.renderCards();
						return;
					}

					wr.setBusy(saveBtn, true, _('Saving...'));
					dom.content(status, wr.inlineStatus('pending', _('Saving...')));
					return Promise.all(jobs).then(function(res) {
						var err = null;
						(res || []).forEach(function(r) {
							if (r && r.ok === false && !err) err = r.error;
						});
						if (err) throw { error: err };
						c.custom_name = name || null;
						c.name = name || c.hostname || c.mac;
						c.pin = pin || null;
						c.pin_name = pin ? (self.apNames()[pin] || pin) : null;
						delete self.editing[c.id];
						wr.notify('success', nameChanged ? _('Name saved') : _('Saved'));
						self.refresh();
					}).catch(function(e) {
						wr.setBusy(saveBtn, false);
						dom.content(status, wr.inlineStatus('fail',
							'✗ ' + _('Failed') + ': ' + errText(e && e.error)));
					});
				}
			}, _('Save'));
			var cancelBtn = E('button', {
				'class': 'btn',
				click: function() {
					delete self.editing[c.id];
					self.renderCards();
				}
			}, _('Cancel'));

			nameIn.addEventListener('keydown', function(ev) {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					saveBtn.click();
				}
			});

			editPanel = E('div', { 'class': 'wr-dcard-edit' }, [
				nameIn,
				E('div', { 'class': 'wr-dcard-pin' }, [
					E('span', { 'class': 'wr-dcard-key' }, _('Pinned AP')),
					pinSel
				]),
				E('div', { 'class': 'wr-dcard-edit-actions' }, [
					saveBtn, cancelBtn, status
				])
			]);
		}

		/* 注意：不能传 disabled:false —— LuCI 的 E() 会把它写成
		   disabled="false"，按钮仍然处于禁用状态 */
		var blockAttrs = {
			'class': 'btn ' + (blocked ? 'cbi-button-positive' : 'cbi-button-negative'),
			click: function(ev) {
				return self.toggleBlock(c, ev.currentTarget);
			}
		};
		if (self.blocking[c.mac]) blockAttrs.disabled = true;
		var blockBtn = E('button', blockAttrs,
			blocked ? _('Resume') : _('Pause'));

		if (self.blocking[c.mac])
			wr.setBusy(blockBtn, true, blocked ? _('Resuming...') : _('Pausing...'));

		var wakeBtn = null;
		if (!online) {
			var wakeAttrs = {
				'class': 'btn cbi-button-action wr-wake-btn',
				click: function(ev) {
					return self.wake(c, ev.currentTarget);
				}
			};
			if (self.waking[c.id]) wakeAttrs.disabled = true;
			wakeBtn = E('button', wakeAttrs, _('Wake on LAN'));
		}

		if (self.waking[c.id])
			wr.setBusy(wakeBtn, true, _('Sending...'));

		var name = (c.name && c.name !== c.mac) ? c.name : (c.hostname || c.mac);

		var rows = [
			this.cardRow(_('IP Address'), c.ip || '-'),
			this.cardRow(_('MAC Address'),
				E('span', { 'class': 'wr-mono' }, (c.mac || '-').toUpperCase())),
			this.cardRow(_('Vendor'), v ? v.name : '-'),
			this.cardRow(_('Connection'), online ? wr.connText(c.conn) : '-'),
			this.cardRow(_('Attached AP'),
				apNames[c.ap] || c.ap_name || c.ap || '-'),
			this.cardRow(_('Signal'), wifi ? wr.rssiText(conn.rssi) : '-'),
			this.cardRow(_('TX Rate (uplink)'),
				wifi ? wr.fmtRate(conn.tx_rate) : '-'),
			this.cardRow(_('Last online'), wr.fmtTime(c.last_online),
				c.last_online
					? E('span', { 'class': 'wr-hint' }, ' (' + wr.fmtAge(c.last_online) + ')')
					: null),
			this.cardRow(_('Last offline'), online ? '-' : wr.fmtTime(c.last_offline))
		];

		return E('div', {
			'class': 'wr-dcard' + (blocked ? ' wr-dcard-blocked' : '') +
				(online ? '' : ' wr-dcard-off') +
				(editing ? ' wr-dcard-editing' : '')
		}, [
			E('div', { 'class': 'wr-dcard-head' }, [
				this.tile(c),
				E('div', { 'class': 'wr-dcard-title-wrap' }, [
					E('div', { 'class': 'wr-dcard-name' }, name),
					(!editing && c.pin) ? E('div', { 'class': 'wr-dcard-pin-tag' },
						_('Pinned to %s').format(c.pin_name || c.pin)) : null
				]),
				roleBadge,
				badge,
				editing ? null : editBtn
			]),
			editPanel,
			E('div', { 'class': 'wr-dcard-rows' }, rows),
			E('div', { 'class': 'wr-dcard-actions' }, [
				blockBtn,
				wakeBtn ? ' ' : null, wakeBtn,
				wakeBtn ? E('span', { 'class': 'wr-hint' },
					_('Send a magic packet to the last known MAC')) : null
			])
		]);
	},

	render: function(data) {
		this.data = data;
		poll.add(L.bind(this.refresh, this), 15);

		var self = this;
		var apNames = this.apNames();

		/* 上次筛选的 AP 已离线/被移除时回到全部，避免页面空白 */
		if (this.filterAp && !apNames[this.filterAp]) {
			this.filterAp = '';
			this.saveUi();
		}

		var search = E('input', {
			type: 'text', 'class': 'cbi-input-text wr-search',
			placeholder: _('Search name / IP / MAC'),
			value: this.filterText || '',
			input: function(ev) {
				self.filterText = ev.target.value;
				self.saveUi();
				self.renderAll();
			}
		});

		var apSel = E('select', {
			'class': 'cbi-input-select',
			change: function(ev) {
				self.filterAp = ev.target.value;
				self.saveUi();
				self.renderAll();
			}
		}, [ E('option', { value: '' }, _('All APs')) ]);
		Object.keys(apNames).forEach(function(id) {
			var opt = E('option', { value: id }, apNames[id]);
			if (self.filterAp === id) opt.selected = true;
			apSel.appendChild(opt);
		});

		var kindSel = E('select', {
			'class': 'cbi-input-select',
			change: function(ev) {
				self.filterKind = ev.target.value;
				self.saveUi();
				self.renderAll();
			}
		}, [
			E('option', { value: '' }, _('All connections')),
			E('option', { value: 'wifi' }, _('Wireless')),
			E('option', { value: 'wired' }, _('Wired'))
		]);
		kindSel.value = this.filterKind;

		var sortSel = E('select', {
			'class': 'cbi-input-select',
			change: function(ev) {
				self.sortBy = ev.target.value;
				self.saveUi();
				self.renderAll();
			}
		}, [
			E('option', { value: 'name' }, _('Sort: name')),
			E('option', { value: 'ip' }, _('Sort: IP')),
			E('option', { value: 'signal' }, _('Sort: signal')),
			E('option', { value: 'rate' }, _('Sort: rate')),
			E('option', { value: 'online' }, _('Sort: online time')),
			E('option', { value: 'ap' }, _('Sort: AP'))
		]);
		sortSel.value = this.sortBy;

		var body = [
			wr.css(),
			E('h2', {}, _('客户端')),
			E('div', { id: 'wr-cl-summary', 'class': 'wr-cards' })
		];

		if (!data) {
			body.push(E('div', { 'class': 'alert-message danger' },
				_('Cannot reach wifiroamd. Make sure the service is running.')));
		}
		else {
			body.push(
				E('div', { 'class': 'wr-toolbar wr-toolbar-wrap' }, [
					search, apSel, kindSel, sortSel,
					E('button', {
						'class': 'btn',
						click: L.bind(function(ev) {
							var btn = ev.currentTarget;
							wr.setBusy(btn, true, _('Refreshing...'));
							this.refresh().then(function() {
								wr.setBusy(btn, false);
							});
						}, this)
					}, _('Refresh')),
					E('span', { id: 'wr-count', 'class': 'wr-hint' })
				]),
				E('div', { id: 'wr-clients' })
			);
		}

		window.setTimeout(L.bind(this.renderAll, this), 0);

		return E('div', {}, body);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
