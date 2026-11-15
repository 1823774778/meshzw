// wifiroam client list view
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';
'require wifiroam.oui as oui';

wr.useOui(oui.data);

var UI_KEY = 'wr_clients_ui';

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

function ipValue(ip) {
	var p = String(ip || '').split('.');
	if (p.length !== 4) return 4294967295;
	var n = 0;
	for (var i = 0; i < 4; i++)
		n = n * 256 + (parseInt(p[i], 10) || 0);
	return n;
}

function vendorDot(mac) {
	var v = wr.vendorOf(mac);
	var color = (v && v.color) || '#90a4ae';
	var text = (v && v.initial) || '?';

	return E('span', {
		'class': 'wr-dev-dot',
		style: 'background:' + color,
		title: (v && v.name) || _('Unknown vendor')
	}, text);
}

return view.extend({
	topo: null,
	filterAp: '',
	filterText: '',
	filterKind: '',
	sortBy: 'name',
	blocking: {},

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

		return wr.safeCall('topology');
	},

	saveUi: function() {
		try {
			sessionStorage.setItem(UI_KEY, JSON.stringify({
				ap: this.filterAp, text: this.filterText,
				kind: this.filterKind, sort: this.sortBy
			}));
		} catch (e) { /* private mode */ }
	},

	/* 表格里是否正在输入：有焦点就绝不重建，否则会吞掉用户正在打的字 */
	hasFocusInTable: function() {
		var box = document.getElementById('wr-clients');
		var el = document.activeElement;

		return !!(box && el && box.contains(el) &&
			/^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
	},

	refresh: function() {
		return wr.safeCall('topology').then(L.bind(function(t) {
			if (!t) return;

			this.topo = t;

			if (Object.keys(this.blocking).length ||
			    this.hasFocusInTable())
				return;

			this.renderAll();
		}, this));
	},

	clients: function() {
		return ((this.topo && this.topo.nodes) || []).filter(function(n) {
			return n.type === 'client';
		});
	},

	filtered: function() {
		var fAp = this.filterAp, fText = (this.filterText || '').toLowerCase();
		var fKind = this.filterKind;

		var list = this.clients().filter(function(c) {
			if (fAp && c.parent !== fAp) return false;
			if (fKind && (c.conn && c.conn.type) !== fKind) return false;
			if (fText) {
				var hay = ((c.name || '') + ' ' + (c.ip || '') + ' ' +
					(c.mac || '') + ' ' + (c.hostname || '')).toLowerCase();
				if (hay.indexOf(fText) < 0) return false;
			}
			return true;
		});

		var apNames = wr.apNameMap((this.topo && this.topo.nodes) || []);
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
				return (apNames[a.parent] || '').localeCompare(apNames[b.parent] || '');
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
			else wired++;
			if (c.blocked) blocked++;
		});

		return { total: list.length, wifi: wifi, wired: wired, blocked: blocked };
	},

	renderSummary: function() {
		var box = document.getElementById('wr-cl-summary');
		if (!box) return;

		var s = this.summary();
		var shown = this.filtered().length;
		var isCap = !!(this.topo && this.topo.role === 'cap');

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
				E('div', { 'class': 'wr-card-label' },
					isCap ? _('Filtered') : _('Read-only on sub AP'))
			])
		]);
	},

	renderAll: function() {
		this.renderSummary();
		this.renderCards();
	},

	openRename: function(c) {
		var self = this;
		var input = E('input', {
			type: 'text', 'class': 'cbi-input-text',
			value: c.custom_name || '',
			placeholder: c.hostname || c.mac,
			style: 'width:100%'
		});

		var save = E('button', {
			'class': 'btn cbi-button-positive',
			click: function() {
				wr.setBusy(save, true, _('Saving...'));
				return wr.call('set_alias', {
					mac: c.mac, name: input.value
				}).then(function(res) {
					if (res && res.ok) {
						c.custom_name = input.value || null;
						c.name = input.value || c.hostname || c.mac;
						ui.hideModal();
						wr.notify('success', _('Name saved'));
						self.renderCards();
					}
					else {
						wr.setBusy(save, false);
						wr.notify('danger', _('Failed') + ': ' +
							((res && res.error) || 'unknown'));
					}
				}).catch(function() {
					wr.setBusy(save, false);
					wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
				});
			}
		}, _('Save'));

		input.addEventListener('keydown', function(ev) {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				save.click();
			}
		});

		ui.showModal(_('Rename') + ' - ' + (c.name || c.mac), [
			E('div', {}, [
				E('div', { 'class': 'wr-hint', style: 'margin-bottom:0.4em' },
					_('Custom name')),
				input
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					click: function() { ui.hideModal(); }
				}, _('Cancel')),
				' ', save
			])
		]);

		window.setTimeout(function() { input.focus(); input.select(); }, 50);
	},

	toggleBlock: function(c, btn) {
		var self = this;

		if (this.blocking[c.mac]) return;

		if (!this.topo || this.topo.role !== 'cap') {
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
						: res.error)) || 'unknown'));
			}
		}).catch(function() {
			wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
		}).then(function() {
			delete self.blocking[c.mac];
			wr.setBusy(btn, false);
			/* 重新拉取拓扑：暂停状态已同步到子 AP，页面立即刷新 */
			self.refresh();
		});
	},

	renderCards: function() {
		var box = document.getElementById('wr-clients');
		if (!box || !this.topo) return;

		var self = this;
		var nodes = this.topo.nodes || [];
		var apNames = wr.apNameMap(nodes);
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

	/* 厂商头像：有品牌 logo 时画 24x24 白色 path，否则用品牌色 + 首字母 */
	avatar: function(c) {
		var v = wr.vendorOf(c.mac);
		var color = (v && v.color) || '#90a4ae';
		var inner = null;

		if (v && v.logo) {
			var ns = 'http://www.w3.org/2000/svg';
			var el = document.createElementNS(ns, 'svg');
			el.setAttribute('viewBox', '0 0 24 24');
			el.setAttribute('width', '22');
			el.setAttribute('height', '22');
			el.setAttribute('fill', '#fff');
			var p = document.createElementNS(ns, 'path');
			p.setAttribute('d', v.logo);
			el.appendChild(p);
			inner = el;
		}
		else {
			inner = E('span', { 'class': 'wr-dcard-initial' },
				(v && v.initial) || (c.name || c.mac || '?').charAt(0).toUpperCase());
		}

		return E('div', { 'class': 'wr-dcard-avatar', style: 'background:' + color },
			inner);
	},

	cardRow: function(label, value, extra) {
		return E('div', { 'class': 'wr-dcard-row' }, [
			E('span', { 'class': 'wr-dcard-key' }, label),
			E('span', { 'class': 'wr-dcard-val' }, [ value, extra ])
		]);
	},

	clientCard: function(c, apNames, now) {
		var self = this;
		var wifi = c.conn && c.conn.type === 'wifi';
		var conn = c.conn || {};
		var blocked = !!c.blocked;
		var level = sigLevel(conn.rssi);
		var since = conn.since ? Math.max(0, now - conn.since) : null;
		var v = wr.vendorOf(c.mac);

		var statusText = blocked ? _('Paused') : (wifi ? _('Online') : _('Wired'));
		var statusCls = blocked ? ' wr-dcard-paused' : '';

		var sig = wifi
			? E('span', { 'class': 'wr-sig ' + wr.rssiClass(conn.rssi) }, [
				E('span', { 'class': 'wr-sig-bars' },
					[0, 1, 2, 3].map(function(i) {
						return E('i', {
							'class': 'wr-sig-bar' + (i < level ? ' on' : '')
						});
					})),
				E('span', {}, wr.rssiText(conn.rssi))
			])
			: '-';

		var rate = wifi
			? E('span', { 'class': 'wr-rate-cell' }, [
				E('span', { 'class': 'wr-dev-up' }, '↑ ' + wr.fmtRate(conn.rx_speed)),
				E('span', { 'class': 'wr-dev-down' }, '↓ ' + wr.fmtRate(conn.tx_speed))
			])
			: '-';

		var blockBtn = E('button', {
			'class': 'btn ' + (blocked ? 'cbi-button-positive' : 'cbi-button-negative'),
			disabled: (self.topo.role !== 'cap') || !!self.blocking[c.mac],
			click: function(ev) {
				return self.toggleBlock(c, ev.currentTarget);
			}
		}, blocked ? _('Resume') : _('Pause'));

		if (self.blocking[c.mac])
			wr.setBusy(blockBtn, true, blocked ? _('Resuming...') : _('Pausing...'));

		var editBtn = E('button', {
			'class': 'btn cbi-button-neutral',
			click: function() { self.openRename(c); }
		}, _('Rename'));

		var name = (c.name && c.name !== c.mac) ? c.name : (c.hostname || c.mac);
		var sub = [];
		if (v && v.name) sub.push(v.name);
		if (c.hostname && c.hostname !== name) sub.push(c.hostname);

		return E('div', {
			'class': 'wr-dcard' + (blocked ? ' wr-dcard-blocked' : '')
		}, [
			E('div', { 'class': 'wr-dcard-head' }, [
				this.avatar(c),
				E('div', { 'class': 'wr-dcard-title-wrap' }, [
					E('div', { 'class': 'wr-dcard-title' }, name),
					E('div', { 'class': 'wr-dcard-sub' }, sub.join(' · ') || '-')
				]),
				E('span', { 'class': 'wr-dcard-status' + statusCls }, [
					E('i', { 'class': 'wr-dcard-dot' }),
					statusText
				])
			]),
			E('div', { 'class': 'wr-dcard-rows' }, [
				this.cardRow(_('IP Address'), c.ip || '-'),
				this.cardRow(_('MAC Address'),
					E('span', { 'class': 'wr-mono' }, (c.mac || '-').toUpperCase())),
				this.cardRow(_('Attached AP'), apNames[c.parent] || c.parent || '-'),
				this.cardRow(_('Connection'), wr.connText(c.conn)),
				this.cardRow(_('Signal'), sig),
				this.cardRow(_('Real-time rate'), rate),
				this.cardRow(_('Online time'),
					since != null ? wr.fmtDur(since) : '-')
			]),
			E('div', { 'class': 'wr-dcard-actions' }, [
				editBtn, ' ', blockBtn
			])
		]);
	},

	render: function(data) {
		this.topo = data;
		poll.add(L.bind(this.refresh, this), 15);

		var nodes = (data && data.nodes) || [];
		var apNames = wr.apNameMap(nodes);
		var self = this;
		var isCap = !!(data && data.role === 'cap');

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
			if (!isCap)
				body.push(E('div', { 'class': 'alert-message warning' },
					_('Clients can be paused only on the main AP. This page is read-only on a sub AP.')));

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
