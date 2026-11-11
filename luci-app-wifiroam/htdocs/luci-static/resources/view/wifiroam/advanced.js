// wifiroam advanced settings view (pre-flight checks, 802.11k/v/r, backhaul)
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';

var RSSI_PRESETS = {
	aggressive:   -62,
	balanced:     -70,
	conservative: -78,
};

return view.extend({
	cfg: null,
	pre: undefined,
	st: null,
	bh: null,
	els: null,
	busy: false,

	load: function() {
		/* precheck / 回程配置放到 hydrate 异步补齐，避免 apk、iw 等命令拖慢首屏 */
		return Promise.all([
			wr.safeCall('get_roam'),
			wr.safeCall('status'),
			wr.safeCall('appctl_status'),
		]);
	},

	hydrate: function() {
		var self = this;

		return Promise.all([
			wr.safeCall('precheck'),
			wr.safeCall('get_backhaul'),
		]).then(function(res) {
			self.pre = (res[0] != null) ? res[0] : null;
			self.bh = res[1];

			var pre = document.getElementById('wr-pre');
			if (pre) dom.content(pre, self.renderChecklist());

			var bh = document.getElementById('wr-bh');
			if (bh) dom.content(bh, self.renderBackhaulPanel(self.isCap()));
		}).catch(function() { /* 单项失败已在 safeCall 内消化 */ });
	},

	isCap: function() {
		return !!(this.st && this.st.role === 'cap');
	},

	/* -------------------------------------------------- 开启前检查 / 成员AP */
	checkLabel: function(c) {
		switch (c.id) {
		case 'wpad':
			return _('Full wpad (802.11r capable)') + ' — ' + (c.info || '');
		case 'ssid_group':
			return _('SSID groups present on 2+ APs') + ' — ' + (c.info || '');
		case 'enc_consistent':
			return _('Encryption consistent') + ' — ' + (c.info || '');
		case 'enc_allowed':
			return _('FT-capable encryption (WPA2-PSK/WPA3-SAE)') + ' — ' + (c.info || '');
		case 'role':
			return _('This device is the main AP (CAP)') + ' — ' + (c.info || '');
		}
		return c.id + ' — ' + (c.info || '');
	},

	renderChecklist: function() {
		var self = this;

		if (this.pre === undefined)
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Pre-flight Checks')),
				E('div', { 'class': 'wr-hint' }, _('Loading pre-flight checks...')),
			]);

		if (!this.pre)
			return E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, _('Pre-flight Checks')),
				E('div', { 'class': 'wr-hint' },
					_('Pre-flight checks unavailable (wifiroamd not reachable).')),
			]);

		var role = this.pre.role || (this.st && this.st.role) || 'unconfigured';
		var isCap = (role === 'cap');

		/* role 检查在子 AP 上天然为 false，改成中性提示而非红色失败 */
		var items = (this.pre.checks || []).filter(function(c) {
			return c.id !== 'role' || isCap;
		}).map(function(c) {
			return E('div', { 'class': c.ok ? 'wr-check-ok' : 'wr-check-fail' },
				(c.ok ? '\u2713 ' : '\u2717 ') + self.checkLabel(c));
		});

		if (!items.length)
			items = [ E('div', {}, _('No checks available')) ];

		var roleHint = null;
		if (!isCap)
			roleHint = E('div', { 'class': 'wr-check-info' },
				_('This device is not the main AP. Run pre-flight checks and roaming settings on the CAP.'));

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Pre-flight Checks')),
			roleHint,
			E('div', {}, items),
			this.renderApTable(),
		]);
	},

	/* 成员 AP 明细：直接展示各 AP 上报的角色/IP/SSID 与 K/V/R 生效状态，
	   便于确认子路由是否真的落盘了漫游配置 */
	renderApTable: function() {
		var aps = (this.pre && this.pre.aps) || [];
		if (!aps.length)
			return '';

		var self = this;
		var rows = aps.map(function(a) {
			return E('tr', {}, [
				E('td', {}, [
					E('b', {}, a.name || a.id || '-'),
					a.self ? E('span', { 'class': 'wr-hint' }, ' ' + _('(this device)')) : '',
				]),
				E('td', {}, wr.roleBadge(a.role)),
				E('td', { style: 'font-family:monospace' }, a.ip || '-'),
				E('td', { 'class': a.online ? 'wr-apply-ok' : 'wr-apply-fail' },
					a.online ? _('Online') : _('Offline')),
				E('td', {}, self.kvrCell(self.kvrOf(a))),
				E('td', {}, (a.ssids && a.ssids.length) ? a.ssids.join(', ') : '-'),
			]);
		});

		return E('div', { 'class': 'wr-ap-table' }, [
			E('h4', {}, _('Member APs')),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', {}, _('AP')),
					E('th', {}, _('Role')),
					E('th', {}, _('IP')),
					E('th', {}, _('Status')),
					E('th', {}, _('R / K / V')),
					E('th', {}, _('SSIDs')),
				]),
			].concat(rows)),
		]);
	},

	/* 各 AP 的 K/V/R 生效状态：优先用 precheck 里的实时值，
	   回退到最近一次下发回执（旧数据源，仅 CAP 有） */
	kvrOf: function(a) {
		if (a && a.kvr) return a.kvr;

		var results = (this.st && this.st.last_apply && this.st.last_apply.results) || [];
		var id = (a && a.id || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
		for (var i = 0; i < results.length; i++) {
			var ap = (results[i].ap || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
			if (ap && ap === id) return results[i].kvr || null;
		}
		return null;
	},

	kvrCell: function(k) {
		if (!k || !k.seen)
			return E('span', { 'class': 'wr-hint' }, '-');

		function tag(on, label) {
			return E('span', {
				'class': 'wr-kvr ' + (on ? 'wr-kvr-on' : 'wr-kvr-off'),
				title: on ? _('Effective') : _('Not effective'),
			}, label);
		}

		return E('span', {}, [
			tag(k.r, 'R'), ' ', tag(k.k, 'K'), ' ', tag(k.v, 'V'),
		]);
	},

	/* 单条结果的状态文案 / 颜色 */
	resultCell: function(r) {
		if (r.ok === null || r.ok === undefined)
			return { cls: 'wr-apply-pending', text: _('Pending') };
		if (r.ok === true)
			return { cls: 'wr-apply-ok', text: _('OK') + (r.ver ? ' (v' + r.ver + ')' : '') };
		return { cls: 'wr-apply-fail',
		         text: _('Failed') + (r.error ? ': ' + r.error : '') };
	},

	renderApplyResults: function(res) {
		if (!res || !res.results)
			return E('div', { 'class': 'wr-hint' }, _('No configuration has been applied yet.'));

		var pending = 0;
		var rows = res.results.map(function(r) {
			var s = this.resultCell(r);
			if (r.ok === null || r.ok === undefined) pending++;
			return E('tr', {}, [
				E('td', {}, r.name || r.ap || '-'),
				E('td', { style: 'font-family:monospace' }, r.ap || '-'),
				E('td', { 'class': s.cls }, s.text),
			]);
		}, this);

		var head = _('Last Apply Result') + ' (v' + (res.ver || '?') + ')';
		if (pending)
			head += ' — ' + _('%d AP(s) still pending').format(pending);

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, head),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', {}, _('AP')), E('th', {}, _('MAC')), E('th', {}, _('Result')),
				]),
			].concat(rows)),
		]);
	},

	/* 只刷新结果区，不动表单（避免用户正在编辑时被打断） */
	renderApply: function() {
		var box = document.getElementById('wr-apply');
		if (box)
			dom.content(box, this.renderApplyResults(this.st && this.st.last_apply));
	},

	/* 下发完成后重新拉取 precheck，让成员 AP 的 K/V/R 生效状态及时更新 */
	refreshPre: function() {
		var self = this;

		return wr.safeCall('precheck').then(function(pre) {
			if (!pre) return;
			self.pre = pre;
			var box = document.getElementById('wr-pre');
			if (box) dom.content(box, self.renderChecklist());
		});
	},

	/* ---------------------------------------------------------- backhaul */
	renderBackhaulResults: function(res) {
		if (!res || !res.results)
			return E('div', { 'class': 'wr-hint' }, _('No configuration has been applied yet.'));

		var pending = 0;
		var self = this;
		var rows = res.results.map(function(r) {
			var s = self.resultCell(r);
			if (r.ok === null || r.ok === undefined) pending++;
			return E('tr', {}, [
				E('td', {}, r.name || r.ap || '-'),
				E('td', { style: 'font-family:monospace' }, r.ap || '-'),
				E('td', { 'class': s.cls }, s.text),
			]);
		});

		var head = _('Backhaul Apply Result') + ' (v' + (res.ver || '?') + ')';
		if (pending)
			head += ' — ' + _('%d AP(s) still pending').format(pending);

		return E('div', {}, [
			E('h4', {}, head),
			E('table', { 'class': 'table cbi-section-table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', {}, _('AP')), E('th', {}, _('MAC')), E('th', {}, _('Result')),
				]),
			].concat(rows)),
		]);
	},

	renderBackhaulApply: function() {
		var box = document.getElementById('wr-bh-apply');
		if (box)
			dom.content(box, this.renderBackhaulResults(this.st && this.st.last_backhaul));
	},

	/* 等成员 AP 回执（ok !== null），超时返回 false */
	waitBackhaulResults: function(ver, timeout) {
		var self = this;

		return wr.pollUntil(function() {
			return wr.safeCall('status').then(function(st) {
				if (!st || !st.last_backhaul || !st.last_backhaul.results)
					return false;
				if (ver != null && st.last_backhaul.ver !== ver)
					return false;

				self.st = st;
				self.renderBackhaulApply();

				return st.last_backhaul.results.every(function(r) {
					return r.ok !== null && r.ok !== undefined;
				});
			});
		}, 1500, timeout || 40000);
	},

	applyBackhaul: function() {
		var self = this;
		if (this.busy) return;

		var e = this.els;
		var ssid = (e.bhSsid.value || '').trim();
		var key = (e.bhKey.value || '').trim();

		if (e.bhEnable.checked && ssid === '') {
			wr.notify('warning', _('Backhaul SSID must not be empty.'));
			return;
		}

		this.setBusy(true);

		return wr.call('set_backhaul', {
			enabled: e.bhEnable.checked,
			ssid: ssid,
			key: key,
			device: e.bhDev.value || '',
		}).then(function(res) {
			if (!res || !res.ok) {
				wr.notify('danger',
					_('Apply failed') + ': ' + ((res && res.error) || _('request rejected')));
				return;
			}

			self.st = self.st || {};
			self.st.last_backhaul = { ver: res.ver, results: res.results };
			self.renderBackhaulApply();

			/* 密钥为空时由 CAP 自动生成，回填到输入框避免用户误以为未设置 */
			if (res.backhaul && res.backhaul.key)
				e.bhKey.value = res.backhaul.key;

			wr.notify('info', _('Backhaul configuration sent, waiting for member APs to confirm...'));

			return self.waitBackhaulResults(res.ver).then(function(allDone) {
				var bad = (self.st.last_backhaul.results || []).filter(function(r) {
					return r.ok === false;
				});

				if (!allDone)
					wr.notify('warning', _('Some APs did not confirm in time. Check the result table below.'));
				else if (bad.length)
					wr.notify('danger', _('Some APs failed to apply backhaul config') + ': ' +
						bad.map(function(r) { return r.name || r.ap; }).join(', '));
				else
					wr.notify('success', _('Wireless backhaul applied to all APs'));
			});
		}).catch(function() {
			wr.notify('danger', _('Apply failed') + ': ' + _('request rejected'));
		}).then(function() {
			self.setBusy(false);
		});
	},

	renderBackhaulPanel: function(isCap) {
		var self = this;
		var src = (this.bh && this.bh.backhaul) || (this.st && this.st.backhaul) || {};
		var radios = (this.bh && this.bh.radios) || [];

		var bhEnable = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		bhEnable.checked = !!src.enabled;

		var bhSsid = E('input', {
			type: 'text', 'class': 'cbi-input-text', placeholder: 'wifiroam-bh',
			style: 'width:16em',
		});
		bhSsid.value = src.ssid || '';

		var bhKey = E('input', {
			type: 'text', 'class': 'cbi-input-text', placeholder: _('Leave empty to generate automatically'),
			style: 'width:16em',
		});
		bhKey.value = src.key || '';

		var bhDev = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: '' }, _('Auto (prefer 5 GHz)')),
		].concat(radios.filter(function(r) { return !r.disabled; }).map(function(r) {
			return E('option', { value: r.name },
				r.name + ' (' + wr.fmtBand(r.band) + ')');
		})));
		bhDev.value = src.device || '';

		var saveBtn = E('button', {
			'class': 'btn cbi-button-positive',
			click: L.bind(this.applyBackhaul, this),
		}, _('Save & Apply'));

		var panel = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Wireless Backhaul')),
			E('div', { 'class': 'wr-hint' },
				_('Creates a hidden WDS backhaul SSID on the main AP and a client uplink on sub APs. ' +
				  'Sub APs with a working cable automatically pause the wireless uplink to avoid L2 loops. ' +
				  'Saving restarts Wi-Fi briefly.')),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, [ bhEnable, ' ', _('Enable wireless backhaul') ]),
			]),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Backhaul SSID')), bhSsid,
			]),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Backhaul key')), bhKey,
			]),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Backhaul radio')), bhDev,
			]),
			isCap ? E('div', {}, [ saveBtn ]) : '',
			E('div', { id: 'wr-bh-apply' }, this.renderBackhaulResults(this.st && this.st.last_backhaul)),
		]);

		this.els = this.els || {};
		this.els.bhEnable = bhEnable;
		this.els.bhSsid = bhSsid;
		this.els.bhKey = bhKey;
		this.els.bhDev = bhDev;
		this.els.bhSaveBtn = saveBtn;
		this.els.bhForm = panel;

		if (!isCap)
			wr.setFormDisabled(panel, true);

		return panel;
	},

	/* 采集勾选的 SSID */
	collectSsids: function() {
		var ssids = [];
		(this.els && this.els.ssidChecks || []).forEach(function(cb) {
			if (cb.checked) ssids.push(cb.getAttribute('data-ssid'));
		});
		return ssids;
	},

	setBusy: function(on) {
		this.busy = on;
		wr.setFormDisabled(this.els.form, on);
		wr.setBusy(this.els.saveBtn, on, on ? _('Applying...') : null);

		if (this.els.bhForm)
			wr.setFormDisabled(this.els.bhForm, on);
		if (this.els.bhSaveBtn)
			wr.setBusy(this.els.bhSaveBtn, on, on ? _('Applying...') : null);
	},

	/* 等所有成员 AP 回执（ok !== null），超时返回 false */
	waitResults: function(ver, timeout) {
		var self = this;

		return wr.pollUntil(function() {
			return wr.safeCall('status').then(function(st) {
				if (!st || !st.last_apply || !st.last_apply.results)
					return false;

				/* 忽略上一轮的旧结果 */
				if (ver != null && st.last_apply.ver !== ver)
					return false;

				self.st = st;
				self.renderApply();

				return st.last_apply.results.every(function(r) {
					return r.ok !== null && r.ok !== undefined;
				});
			});
		}, 1500, timeout || 30000);
	},

	apply: function() {
		var self = this;

		if (this.busy) return;

		var e = this.els;
		var ssids = this.collectSsids();

		if (e.enableCb.checked && ssids.length === 0) {
			wr.notify('warning', _('Select at least one roaming SSID group.'));
			return;
		}

		this.setBusy(true);

		return wr.call('set_roam', {
			enabled: e.enableCb.checked,
			ssids: ssids,
			r_fast: e.rFast.checked,
			ft_mode: e.ftSel.value,
			ft_over_ds: e.ftDs.checked,
			k_neighbor: e.kN.checked,
			k_beacon: e.kB.checked,
			v_bss_transition: e.vB.checked,
			rssi_profile: e.rssiSel.value,
			rssi_threshold: parseInt(e.rssiVal.value, 10) || 0,
		}).then(function(res) {
			if (!res || !res.ok) {
				wr.notify('danger',
					_('Apply failed') + ': ' + ((res && res.error) || _('request rejected')));
				return;
			}

			self.st = self.st || {};
			self.st.last_apply = { ver: res.ver, results: res.results };
			self.renderApply();

			if (res.results && res.results.some(function(r) {
				return r.ok === null || r.ok === undefined;
			})) {
				wr.notify('info', _('Configuration sent, waiting for member APs to confirm...'));

				return self.waitResults(res.ver).then(function(allDone) {
					var bad = (self.st.last_apply.results || []).filter(function(r) {
						return r.ok === false;
					});

					if (!allDone)
						wr.notify('warning', _('Some APs did not confirm in time. Check the result table below.'));
					else if (bad.length)
						wr.notify('danger', _('Some APs failed to apply roaming config') + ': ' +
							bad.map(function(r) { return r.name || r.ap; }).join(', '));
					else
						wr.notify('success', _('Roaming configuration applied to all APs'));
				});
			}

			wr.notify('success', _('Roaming configuration applied'));
		}).catch(function() {
			wr.notify('danger',
				_('Apply failed') + ': ' + _('request rejected'));
		}).then(function() {
			self.setBusy(false);
			self.refreshPre();
		});
	},

	/* 定时刷新状态条与结果区；提交过程中跳过 */
	pollStatus: function() {
		var self = this;

		if (this.busy) return Promise.resolve();

		return wr.safeCall('status').then(function(st) {
			if (!st) return;

			self.st = st;

			var sb = document.getElementById('wr-status');
			if (sb) dom.content(sb, wr.statusBar(st));

			self.renderApply();
		});
	},

	/* ------------------------------------------------ 应用识别与统计（精准模式） */
	/* 精准模式：锁定 DNS 出口 + 严格活跃判定 + 缩短归属缓存 + 挂起硬件加速。
	   关闭时保持宽松口径（兼容旧行为）。依赖设备页的「应用使用与访问控制」总开关 */
	renderAppctlPanel: function(isCap) {
		var self = this;
		var ac = this.appctl || {};
		var usable = isCap && ac.ok && ac.enabled === true;

		var cb = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		cb.checked = (ac.enhanced === true);

		var btn = E('button', {
			'class': 'btn cbi-button-positive',
			click: function() {
				wr.setBusy(btn, true, _('Applying...'));
				wr.call('set_appctl', {
					enabled: ac.enabled, enhanced: cb.checked,
				}).then(function(res) {
					wr.setBusy(btn, false);
					if (!res || !res.ok) {
						wr.notify('danger', _('Failed') + ': ' +
							((res && res.error) || 'unknown'));
						return;
					}
					ac.enhanced = (res.enhanced === true);
					wr.notify('success', cb.checked
						? _('Precise mode enabled. Hardware flow offload was suspended to keep counters complete.')
						: _('Precise mode disabled. Reverted to the lenient mode.'));
				}).catch(function() {
					wr.setBusy(btn, false);
					wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
				});
			},
		}, _('Save'));

		var kids = [
			E('h3', {}, _('App Recognition & Statistics')),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, [ cb, ' ', _('Precise mode (recommended)') ]),
				E('div', { 'class': 'wr-hint' },
					_('Locks DNS egress to this router so apps cannot bypass recognition via built-in HTTPDNS/DoH/DoT; ' +
					  'counts usage time only when a window has real traffic (idle keep-alives ignored); ' +
					  'expires DNS-to-app mapping in 30 minutes to avoid stale CDN attribution; ' +
					  'suspends hardware flow offload while enabled so traffic counters stay complete (restored on disable).')),
			]),
			isCap ? E('div', {}, [ btn ]) : '',
		];

		if (!usable) {
			cb.disabled = true;
			btn.disabled = true;
			kids.splice(1, 0, E('div', { 'class': 'wr-hint' },
				!isCap
					? _('App recognition can only be configured on the main AP.')
					: _('Enable "App Usage & Access Control" on the Clients page first.')));
		}

		return E('div', { 'class': 'cbi-section' }, kids);
	},

	render: function(data) {
		this.cfg = data[0];
		this.st = data[1] || {};
		this.appctl = data[2] || null;

		var isCap = (this.st.role === 'cap');

		/* 次要面板先占位，render 返回后立即异步补齐 */
		window.setTimeout(L.bind(this.hydrate, this), 0);

		if (!this.cfg) {
			return E('div', {}, [
				wr.css(),
				wr.navTabs('advanced'),
				E('h2', {}, _('高级设置')),
				E('div', { 'class': 'alert-message danger' },
					_('无法连接 wifiroamd，请先在首页启动插件服务，然后刷新本页。')),
			]);
		}

		var roam = this.cfg.roam || {};
		var groups = this.cfg.groups || [];
		var self = this;

		var notice = null;
		if (!isCap) {
			var roleNames = {
				cap: _('主路由（CAP）'),
				sap: _('子路由（SAP）'),
				unconfigured: _('未组网'),
			};
			notice = E('div', { 'class': 'alert-message warning' },
				_('漫游只能在主路由（CAP）上配置。当前设备角色：') +
				(roleNames[this.st.role] || this.st.role || '-'));
		}

		// ---- form widgets ----
		var enableCb = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		enableCb.checked = !!roam.enabled;

		var ssidChecks = [];
		var ssidBoxes = groups.map(function(g) {
			var cb = E('input', { type: 'checkbox', 'class': 'cbi-input-checkbox',
			                      'data-ssid': g.ssid });
			cb.checked = (roam.ssids || []).indexOf(g.ssid) >= 0;
			ssidChecks.push(cb);

			return E('div', { 'class': 'wr-ssid-group' }, [
				E('label', {}, [ cb, ' ', E('b', {}, g.ssid) ]),
				E('div', { 'class': 'wr-hint' },
					_('APs') + ': ' + g.ap_count + ' | ' +
					_('Bands') + ': ' + (g.bands || []).map(wr.fmtBand).join(', ') + ' | ' +
					_('Encryption') + ': ' + (g.encryptions || []).join(', ') +
					(g.consistent ? '' : ' (' + _('inconsistent!') + ')')),
			]);
		});
		if (!ssidBoxes.length)
			ssidBoxes = [ E('div', { 'class': 'wr-hint' },
				_('No AP interfaces found. Configure Wi-Fi SSIDs first.')) ];

		var ftSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'simple' }, _('Simple (local key derivation, WPA2-PSK)')),
			E('option', { value: 'explicit' }, _('Expert (sync r0kh/r1kh, supports WPA3/EAP)')),
		]);
		ftSel.value = roam.ft_mode || 'simple';

		/* 802.11r 独立开关：关闭后只保留 11k/11v 引导 */
		var rFast = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		rFast.checked = roam.r_fast !== false;

		var ftDs = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		ftDs.checked = roam.ft_over_ds !== false;

		/* R 关闭时 FT mode / over DS 无意义，一并置灰 */
		function syncFt() {
			var off = !rFast.checked;
			ftSel.disabled = off;
			ftDs.disabled = off;
		}
		rFast.addEventListener('change', syncFt);
		syncFt();

		var kN = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		kN.checked = roam.k_neighbor !== false;
		var kB = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		kB.checked = roam.k_beacon !== false;
		var vB = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		vB.checked = roam.v_bss_transition !== false;

		/* RSSI 阈值：三档预设 + 自定义；非 custom 时输入框只读显示预设值 */
		var rssiSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: 'aggressive' },
				_('Aggressive') + ' (-62 dBm)'),
			E('option', { value: 'balanced' },
				_('Balanced') + ' (-70 dBm)'),
			E('option', { value: 'conservative' },
				_('Conservative') + ' (-78 dBm)'),
			E('option', { value: 'custom' }, _('Custom')),
		]);
		rssiSel.value = (roam.rssi_profile === 'custom' ||
		                 RSSI_PRESETS[roam.rssi_profile]) ? roam.rssi_profile : 'balanced';

		var rssiVal = E('input', {
			type: 'number', min: '-95', max: '-30', step: '1',
			'class': 'cbi-input-text', style: 'width:6em',
		});
		rssiVal.value = roam.rssi_threshold != null
			? roam.rssi_threshold
			: RSSI_PRESETS[rssiSel.value];
		rssiVal.disabled = (rssiSel.value !== 'custom');

		rssiSel.addEventListener('change', function() {
			var custom = (rssiSel.value === 'custom');
			rssiVal.disabled = !custom;
			if (!custom)
				rssiVal.value = RSSI_PRESETS[rssiSel.value];
		});

		function cRow(label, widget, hint) {
			return E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, label), widget,
				hint ? E('div', { 'class': 'wr-hint' }, hint) : '',
			]);
		}
		function cbRow(label, widget, hint) {
			return E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, [ widget, ' ', label ]),
				hint ? E('div', { 'class': 'wr-hint' }, hint) : '',
			]);
		}

		var saveBtn = E('button', {
			'class': 'btn cbi-button-positive',
			click: L.bind(this.apply, this),
		}, _('Save & Apply'));

		var form = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('802.11k/v/r Seamless Roaming')),
			cbRow(_('Enable seamless roaming'), enableCb,
				_('Same SSID + same password must exist on all member APs. Wired backhaul between APs is recommended.')),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Roaming SSID groups')),
			].concat(ssidBoxes)),
			cbRow(_('802.11r fast transition (R)'), rFast,
				_('When disabled, only 802.11k neighbor reports and 802.11v steering are used (no FT handover).')),
			cRow(_('FT mode'), ftSel,
				_('Simple needs no key sync. Expert mode distributes FT keys to all member APs automatically.')),
			cbRow(_('FT over DS (recommended with wired backhaul)'), ftDs),
			cbRow(_('802.11k neighbor report'), kN),
			cbRow(_('802.11k beacon report'), kB),
			cbRow(_('802.11v BSS transition management'), vB),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Roaming trigger threshold (RSSI)')),
				E('div', { 'class': 'wr-rssi-row' }, [
					rssiSel, ' ', rssiVal, ' dBm',
				]),
				E('div', { 'class': 'wr-hint' },
					_('When a client signal drops below this level, 802.11v BSS Transition asks it to move to a better AP.')),
			]),
			isCap ? E('div', {}, [ saveBtn ]) : '',
		]);

		this.els = {
			form: form, saveBtn: saveBtn, enableCb: enableCb, ssidChecks: ssidChecks,
			rFast: rFast, ftSel: ftSel, ftDs: ftDs, kN: kN, kB: kB, vB: vB,
			rssiSel: rssiSel, rssiVal: rssiVal,
		};

		/* 非 CAP 只读：整块表单禁用 */
		if (!isCap)
			wr.setFormDisabled(form, true);

		poll.add(L.bind(this.pollStatus, this), 15);

		return E('div', { id: 'wr-adv' }, [
			wr.css(),
			wr.navTabs('advanced'),
			E('h2', {}, _('高级设置')),
			E('div', { id: 'wr-status' }, wr.statusBar(this.st || {})),
			notice,
			E('div', { id: 'wr-pre' }, this.renderChecklist()),
			form,
			this.renderAppctlPanel(isCap),
			E('div', { id: 'wr-apply' }, this.renderApplyResults(this.st.last_apply)),
			E('div', { id: 'wr-bh' },
				E('div', { 'class': 'wr-hint' }, _('Loading wireless backhaul settings...'))),
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
