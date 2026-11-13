// wifiroam client list view
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';
'require wifiroam.oui as oui';

wr.useOui(oui.data);

return view.extend({
	topo: null,
	filterAp: '',
	filterText: '',
	saving: {},      // mac -> true
	savingCount: 0,

	load: function() {
		return wr.safeCall('topology');
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

			if (this.savingCount > 0 || this.hasFocusInTable())
				return;

			this.renderTable();
		}, this));
	},

	saveName: function(c, input, btn, status) {
		var self = this;

		if (this.saving[c.mac]) return;

		this.saving[c.mac] = true;
		this.savingCount++;
		wr.setBusy(btn, true, _('Saving...'));
		dom.content(status, wr.inlineStatus('pending', _('Saving...')));

		return wr.call('set_alias', { mac: c.mac, name: input.value }).then(function(res) {
			if (res && res.ok) {
				/* 本地先更新，避免下一次轮询把名字刷回旧值前出现闪一下 */
				c.name = input.value || c.hostname || c.mac;
				dom.content(status, wr.inlineStatus('ok', '✓ ' + _('Saved')));
			}
			else {
				dom.content(status, wr.inlineStatus('fail',
					'✗ ' + _('Failed') + (res && res.error ? ': ' + res.error : '')));
			}
		}, function() {
			dom.content(status, wr.inlineStatus('fail',
				'✗ ' + _('Failed') + ': ' + _('request rejected')));
		}).then(function() {
			delete self.saving[c.mac];
			self.savingCount--;
			wr.setBusy(btn, false);
		});
	},

	renderTable: function() {
		var box = document.getElementById('wr-clients');
		if (!box || !this.topo) return;

		var nodes = this.topo.nodes || [];
		var apNames = wr.apNameMap(nodes);
		var clients = nodes.filter(function(n) { return n.type === 'client'; });
		var fAp = this.filterAp, fText = (this.filterText || '').toLowerCase();

		clients = clients.filter(function(c) {
			if (fAp && c.parent !== fAp) return false;
			if (fText) {
				var hay = ((c.name || '') + ' ' + (c.ip || '') + ' ' +
					(c.mac || '') + ' ' + (c.hostname || '')).toLowerCase();
				if (hay.indexOf(fText) < 0) return false;
			}
			return true;
		});

		var self = this;
		var rows = clients.map(function(c) {
			var busy = !!self.saving[c.mac];

			var input = E('input', {
				type: 'text', 'class': 'cbi-input-text',
				value: (c.name && c.name !== c.mac) ? c.name : '',
				placeholder: c.hostname || c.mac,
				style: 'width:11em',
			});

			var btn = E('button', {
				'class': 'btn cbi-button-positive',
				click: function() { return self.saveName(c, input, btn, status); },
			}, busy ? _('Saving...') : _('Save'));

			var status = E('span', { 'class': 'wr-hint', style: 'margin-left:0.5em' });

			input.addEventListener('keydown', function(ev) {
				if (ev.key === 'Enter') {
					ev.preventDefault();
					self.saveName(c, input, btn, status);
				}
			});

			if (busy) {
				btn.disabled = true;
				btn.classList.add('spinning');
			}

			return E('tr', {}, [
				E('td', {}, [ input, ' ', btn, status ]),
				E('td', {}, c.ip || '-'),
				E('td', {}, c.mac || '-'),
				E('td', {}, (wr.vendorOf(c.mac) || {}).name || '-'),
				E('td', {}, wr.connText(c.conn)),
				E('td', {}, apNames[c.parent] || c.parent || '-'),
				E('td', {}, c.conn && c.conn.type === 'wifi'
					? wr.rssiText(c.conn.rssi) : '-'),
				E('td', {}, c.conn && c.conn.type === 'wifi'
					? wr.fmtRate(c.conn.rx_rate) : '-'),
			]);
		});

		var table = E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', {}, _('Name')),
				E('th', {}, _('IP Address')),
				E('th', {}, _('MAC Address')),
				E('th', {}, _('Vendor')),
				E('th', {}, _('Connection')),
				E('th', {}, _('Attached AP')),
				E('th', {}, _('Signal')),
				E('th', {}, _('TX Rate (uplink)')),
			]),
		]);
		rows.forEach(function(r) { table.appendChild(r); });
		if (!rows.length)
			table.appendChild(E('tr', { 'class': 'tr placeholder' }, [
				E('td', { colspan: 8 }, _('No clients found')),
			]));

		var cnt = document.getElementById('wr-count');
		if (cnt)
			dom.content(cnt, _('%d clients').format(clients.length));

		dom.content(box, table);
	},

	render: function(data) {
		this.topo = data;
		poll.add(L.bind(this.refresh, this), 15);

		var nodes = (data && data.nodes) || [];
		var apNames = wr.apNameMap(nodes);
		var self = this;

		var apSel = E('select', { 'class': 'cbi-input-select',
			change: function(ev) { self.filterAp = ev.target.value; self.renderTable(); },
		}, [ E('option', { value: '' }, _('All APs')) ]);
		Object.keys(apNames).forEach(function(id) {
			apSel.appendChild(E('option', { value: id }, apNames[id]));
		});

		var search = E('input', {
			type: 'text', 'class': 'cbi-input-text',
			placeholder: _('Search name / IP / MAC'),
			style: 'width:15em',
			input: function(ev) { self.filterText = ev.target.value; self.renderTable(); },
		});

		var body = [
			wr.css(),
			E('h2', {}, _('客户端')),
		];

		if (!data)
			body.push(E('div', { 'class': 'alert-message danger' },
				_('Cannot reach wifiroamd. Make sure the service is running.')));
		else
			body.push(
				E('div', { 'class': 'wr-toolbar' }, [
					apSel, search,
					E('span', { id: 'wr-count', 'class': 'wr-hint' }),
				]),
				E('div', { id: 'wr-clients' }));

		return E('div', {}, body);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
