// wifiroam client devices view (r91 layout + history, pinned AP, Wake on LAN)
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';
'require wifiroam.oui as oui';

wr.useOui(oui.data);

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
				E('div', { 'class': 'wr-card-label' },
					isCap ? _('Filtered') : _('Read-only on sub AP'))
			])
		]);
	},

	renderAll: function() {
		this.renderSummary();
		this.renderCards();
	},

	/* 改名弹窗：保留 r91 的名称编辑，并追加固定 AP（pin）选择 */
	openRename: function(c) {
		var self = this;
		var input = E('input', {
			type: 'text', 'class': 'cbi-input-text',
			value: c.custom_name || '',
			placeholder: c.hostname || c.mac,
			style: 'width:100%'
		});

		var pinSel = E('select', { 'class': 'cbi-input-select', style: 'width:100%' }, [
			E('option', { value: '' }, _('Auto (no pin)'))
		]);
		var known = {};
		((this.data && this.data.aps) || []).forEach(function(a) {
			known[a.id] = true;
			pinSel.appendChild(E('option', { value: a.id }, a.name || a.id));
		});
		if (c.pin && !known[c.pin])
			pinSel.appendChild(E('option', { value: c.pin }, c.pin_name || c.pin));
		pinSel.value = c.pin || '';

		var save = E('button', {
			'class': 'btn cbi-button-positive',
			click: function() {
				var name = (input.value || '').trim();
				var pin = pinSel.value || '';
				var nameChanged = (name !== (c.custom_name || ''));
				var jobs = [];

				if (nameChanged)
					jobs.push(wr.call('set_alias', { mac: c.id, name: name }));
				if (pin !== (c.pin || ''))
					jobs.push(wr.call('set_pin', { mac: c.id, ap: pin }));

				if (!jobs.length) {
					ui.hideModal();
					return;
				}

				wr.setBusy(save, true, _('Saving...'));
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
					ui.hideModal();
					wr.notify('success', nameChanged ? _('Name saved') : _('Saved'));
					self.refresh();
				}).catch(function(e) {
					wr.setBusy(save, false);
					wr.notify('danger', _('Failed') + ': ' + errText(e && e.error));
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
				input,
				E('div', { 'class': 'wr-hint', style: 'margin:0.7em 0 0.4em' },
					_('Pinned AP')),
				pinSel,
				E('div', { 'class': 'wr-hint', style: 'margin-top:0.4em' },
					_('A pinned client is disconnected and blocked for 2 minutes when it connects to another AP.'))
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

		if (!this.data || this.data.role !== 'cap') {
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
		var online = !!c.online;
		var wifi = c.conn && c.conn.type === 'wifi';
		var conn = c.conn || {};
		var blocked = !!c.blocked;
		var v = wr.vendorOf(c.mac);

		/* 图三布局：头像 + 名称 + 在线徽标 + 编辑铅笔 */
		var badge = E('span', {
			'class': 'wr-badge' + (blocked ? '' :
				(online ? ' wr-badge-on' : ' wr-badge-off')),
			style: blocked ? 'background:#c62828' : null
		}, blocked ? _('Paused') : (online ? _('Online') : _('Offline')));

		var editBtn = E('button', {
			'class': 'wr-dcard-edit-btn',
			title: _('Edit'),
			'aria-label': _('Edit'),
			click: function(ev) {
				ev.stopPropagation();
				self.openRename(c);
			}
		}, [ pencilIcon() ]);

		var blockBtn = E('button', {
			'class': 'btn ' + (blocked ? 'cbi-button-positive' : 'cbi-button-negative'),
			disabled: (self.data.role !== 'cap') || !!self.blocking[c.mac],
			click: function(ev) {
				return self.toggleBlock(c, ev.currentTarget);
			}
		}, blocked ? _('Resume') : _('Pause'));

		if (self.blocking[c.mac])
			wr.setBusy(blockBtn, true, blocked ? _('Resuming...') : _('Pausing...'));

		var wakeBtn = (!online && c.can_wake)
			? E('button', {
				'class': 'btn cbi-button-action',
				disabled: !!self.waking[c.id],
				click: function(ev) {
					return self.wake(c, ev.currentTarget);
				}
			}, _('Wake on LAN'))
			: null;

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
				(online ? '' : ' wr-dcard-off')
		}, [
			E('div', { 'class': 'wr-dcard-head' }, [
				this.avatar(c),
				E('div', { 'class': 'wr-dcard-title-wrap' }, [
					E('div', { 'class': 'wr-dcard-name' }, name),
					c.pin ? E('div', { 'class': 'wr-dcard-pin-tag' },
						_('Pinned to %s').format(c.pin_name || c.pin)) : null
				]),
				badge,
				editBtn
			]),
			E('div', { 'class': 'wr-dcard-rows' }, rows),
			E('div', { 'class': 'wr-dcard-actions' }, [
				blockBtn,
				wakeBtn ? ' ' : null, wakeBtn
			])
		]);
	},

	render: function(data) {
		this.data = data;
		poll.add(L.bind(this.refresh, this), 15);

		var self = this;
		var isCap = !!(data && data.role === 'cap');
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
