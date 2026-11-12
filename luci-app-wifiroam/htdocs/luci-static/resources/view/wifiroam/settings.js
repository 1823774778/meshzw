// wifiroam wireless settings view (Wi-Fi, guest, pairing)
'use strict';
'require view';
'require poll';
'require dom';
'require wifiroam.common as wr';

return view.extend({
	pre: undefined,
	st: null,
	busy: false,
	actionBusy: false,

	load: function() {
		wr.mountNav('settings');

		return Promise.all([
			wr.safeCall('status'),
			wr.safeCall('offload_status'),
			wr.safeCall('get_wifi'),
			wr.safeCall('get_guest'),
			wr.safeCall('discover'),
			wr.safeCall('topology'),
		]);
	},

	/* ---------------------------------------------------------- Wi-Fi 设置 */
	/* 多频合一：开启时所有频段用同一个名称/密码（终端自动选频）；关闭时
	   每个频段各自一套名称/密码。主AP 保存后由守护进程按频段同步到所有
	   已配对 AP，无线会在几秒后重启，终端需要重新连接 */
	renderWifiPanel: function() {
		var self = this;
		var w = this.wifi || {};
		var isCap = (w.role === 'cap') || this.isCap();
		var ifaces = w.ifaces || [];

		var bands = [];
		ifaces.forEach(function(it) {
			if (bands.indexOf(it.band) < 0) bands.push(it.band);
		});
		bands.sort();

		/* ---- 多频合一开关 ---- */
		var uniCb = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		uniCb.checked = (w.unified === true);

		var uniHint = E('div', { 'class': 'wr-hint' });

		/* ---- 合一：单组名称/密码 ---- */
		var uniSsid = E('input', {
			type: 'text', 'class': 'cbi-input-text',
			style: 'width:16em', maxlength: '32',
			placeholder: _('Wi-Fi Name (SSID)'),
		});
		uniSsid.value = w.ssid || '';

		var uniKey = E('input', {
			type: 'password', 'class': 'cbi-input-text',
			style: 'width:16em', maxlength: '64', autocomplete: 'new-password',
			placeholder: _('Leave blank to keep current password'),
		});

		var unifiedBox = E('div', { 'class': 'wr-band-group' }, [
			E('h4', {}, _('Main Network')),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Wi-Fi Name (SSID)')), uniSsid,
			]),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, _('Wi-Fi Password')), uniKey,
				E('div', { 'class': 'wr-hint' },
					_('At least 8 characters. Leave blank to keep the current password.')),
			]),
		]);

		/* ---- 不合一：每个频段一组名称/密码 ---- */
		var bandInputs = [];
		var splitKids = [];

		bands.forEach(function(b) {
			var cur = null;
			ifaces.forEach(function(it) { if (!cur && it.band === b) cur = it; });

			var nameEl = E('input', {
				type: 'text', 'class': 'cbi-input-text',
				style: 'width:16em', maxlength: '32',
				placeholder: _('Wi-Fi Name (SSID)'),
			});
			nameEl.value = cur ? (cur.ssid || '') : '';

			var keyEl = E('input', {
				type: 'password', 'class': 'cbi-input-text',
				style: 'width:16em', maxlength: '64', autocomplete: 'new-password',
				placeholder: _('Leave blank to keep current password'),
			});

			bandInputs.push({ band: b, nameEl: nameEl, keyEl: keyEl });

			splitKids.push(E('div', { 'class': 'wr-band-group' }, [
				E('h4', {}, wr.fmtBand(b) + ' Wi-Fi'),
				E('div', { 'class': 'wr-form-row' }, [
					E('label', {}, _('Wi-Fi Name (SSID)')), nameEl,
				]),
				E('div', { 'class': 'wr-form-row' }, [
					E('label', {}, _('Wi-Fi Password')), keyEl,
					E('div', { 'class': 'wr-hint' },
						_('At least 8 characters. Leave blank to keep the current password.')),
				]),
			]));
		});

		if (!bands.length)
			splitKids.push(E('div', { 'class': 'wr-hint' },
				_('No AP interfaces found. Configure Wi-Fi SSIDs first.')));

		var splitBox = E('div', {}, splitKids);

		/* 开关切换时只切显示，不重建 DOM，避免输入内容丢失 */
		function syncMode() {
			var on = uniCb.checked;
			unifiedBox.style.display = on ? '' : 'none';
			splitBox.style.display = on ? 'none' : '';
			uniHint.textContent = on
				? _('2.4G and 5G networks use the same name and password; clients automatically connect to the best band.')
				: _('Clients will not automatically switch to the best of the 2.4G and 5G networks.');
			if (on && !uniSsid.value && bandInputs.length)
				uniSsid.value = bandInputs[0].nameEl.value;
		}
		uniCb.addEventListener('change', syncMode);
		syncMode();

		var btn = E('button', {
			'class': 'btn cbi-button-positive',
			click: function() {
				self.applyWifi({
					uniCb: uniCb, uniSsid: uniSsid, uniKey: uniKey,
					bandInputs: bandInputs,
				}, btn, resBox);
			},
		}, _('Save Wi-Fi'));

		var resBox = E('div', { 'class': 'wr-hint' },
			w.last ? this.renderWifiResults(w.last.results) : '');
		var channelHint = E('div', { id: 'wr-wifi-channel-hint' });

		/* LuCI 的 E() 不会展开嵌套数组（会变成 "[object HTMLDivElement]"） */
		var kids = [
			E('h3', {}, _('Wi-Fi Settings')),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, [ uniCb, ' ', _('Multi-band unified') ]),
			]),
			uniHint,
			unifiedBox,
			splitBox,
			E('div', { 'class': 'wr-form-row' }, [
				isCap ? btn : E('div', { 'class': 'wr-hint' },
					_('Wi-Fi settings can only be changed on the main AP.')),
				E('div', { 'class': 'wr-hint' },
					_('Applies to all paired APs. Radios restart after saving, clients will reconnect.')),
			]),
			resBox,
			channelHint,
		];

		var panel = E('div', { 'class': 'cbi-section' }, kids);

		if (isCap)
			window.setTimeout(L.bind(this.checkChannelHint, this), 0);

		if (!isCap || !bandInputs.length) {
			uniCb.disabled = true;
			uniSsid.disabled = true;
			uniKey.disabled = true;
			bandInputs.forEach(function(bi) {
				bi.nameEl.disabled = true;
				bi.keyEl.disabled = true;
			});
			btn.disabled = true;
			resBox.textContent = '';
		}
		return panel;
	},

	renderWifiResults: function(results) {
		if (!results || !results.length) return '';
		var s = '';
		results.forEach(function(r) {
			var mark = (r.ok === true) ? '\u2713'
				: (r.ok === false ? '\u2717' : '\u2026');
			s += (s ? '  ' : '') + (r.name || r.ap || '') + ' ' + mark;
		});
		return _('Last result') + ': ' + s;
	},

	applyWifi: function(form, btn, resBox) {
		var self = this;
		var ifaces = [];
		var badSsid = false;
		var badKey = false;

		function collect(band, ssidEl, keyEl) {
			var ssid = (ssidEl.value || '').trim();
			var key = keyEl.value || '';
			if (!ssid || ssid.length > 32) badSsid = true;
			if (key !== '' && key.length < 8) badKey = true;
			ifaces.push({ band: band, ssid: ssid, key: key });
		}

		if (form.uniCb.checked) {
			/* 合一：所有频段用同一组名称/密码；密码留空时由守护进程把
			   现有密码复制到所有频段，保证真正「合一」 */
			form.bandInputs.forEach(function(bi) {
				collect(bi.band, form.uniSsid, form.uniKey);
			});
		} else {
			form.bandInputs.forEach(function(bi) {
				collect(bi.band, bi.nameEl, bi.keyEl);
			});
		}

		if (badSsid) {
			wr.notify('warning', _('SSID must be 1-32 characters'));
			return;
		}
		if (badKey) {
			wr.notify('warning', _('Password must be at least 8 characters'));
			return;
		}

		wr.setBusy(btn, true, _('Applying...'));

		wr.call('set_wifi', {
			unified: !!form.uniCb.checked,
			ifaces: ifaces,
		}).then(function(res) {
			wr.setBusy(btn, false);
			if (!res || !res.ok) {
				var why = res && res.error;
				wr.notify('danger', _('Failed') + ': ' +
					(why === 'not_cap' ? _('Only the main AP can change Wi-Fi settings')
					 : why === 'ssid_invalid' ? _('SSID must be 1-32 characters')
					 : why === 'key_invalid' ? _('Password must be at least 8 characters')
					 : (why || 'unknown')));
				return;
			}
			form.uniKey.value = '';
			form.bandInputs.forEach(function(bi) { bi.keyEl.value = ''; });
			if (resBox) dom.content(resBox, self.renderWifiResults(res.results));
			/* 成员 AP 的结果是异步回传的（pending → ok），本页没有轮询，
			   这里补几次短轮询把「…」刷新成 ✓/✗ */
			self.refreshWifiResults(resBox);
			/* 无线重启后重新检查同频，给用户一个跳转高级设置的入口 */
			window.setTimeout(function() { self.checkChannelHint(); }, 6000);
			wr.notify('success',
				_('Wi-Fi updated. Radios restart in a few seconds, clients will reconnect.'));
		}).catch(function() {
			wr.setBusy(btn, false);
			wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
		});
	},

	/* 短轮询：等成员 AP 回传结果，最多 6 次（约 15 秒） */
	refreshWifiResults: function(resBox) {
		var self = this;
		var tries = 0;

		function tick() {
			tries++;
			wr.safeCall('get_wifi').then(function(st) {
				if (!st || !st.last || !resBox) return;
				dom.content(resBox, self.renderWifiResults(st.last.results));
				var pending = (st.last.results || []).some(function(r) {
					return r.ok === null || r.ok === undefined;
				});
				if (pending && tries < 6)
					window.setTimeout(tick, 2500);
			});
		}
		window.setTimeout(tick, 2500);
	},

	/* 保存 WiFi 后检测同频，只提示，不自动改信道 */
	checkChannelHint: function() {
		var el = document.getElementById('wr-wifi-channel-hint');
		if (!el) return Promise.resolve();

		return wr.safeCall('get_channel').then(function(ch) {
			if (!el.parentNode) return;
			if (ch && ch.cochannel && ch.cochannel.any) {
				dom.content(el, E('div', { 'class': 'alert-message warning' }, [
					_('检测到 AP 同频，建议优化信道。'), ' ',
					E('a', { href: L.url('admin/network/wifiroam/advanced') },
						_('前往高级设置')),
				]));
			}
			else {
				dom.content(el, '');
			}
		}).catch(function() {});
	},

	/* ---------------------------------------------------------- 访客网络 */
	/* 参照 TP-Link：总开关打开后显示名称/密码/限速/开放时间/内网访问。
	   主AP 保存后推送到所有已配对 AP，各 AP 建自己的访客子网。
	   关闭时只显示开关。 */
	renderGuestPanel: function() {
		var self = this;
		var g = this.guest || {};
		var isCap = (g.role === 'cap') || this.isCap();
		var hasKey = (g.has_key === true);

		var cb = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		cb.checked = (g.enabled === true);

		var ssidEl = E('input', {
			type: 'text', 'class': 'cbi-input-text', style: 'width:16em',
			maxlength: '32', placeholder: _('Wi-Fi Name (SSID)'),
		});
		ssidEl.value = g.ssid || '';

		var keyEl = E('input', {
			type: 'password', 'class': 'cbi-input-text', style: 'width:16em',
			maxlength: '64', autocomplete: 'new-password',
			placeholder: hasKey ? _('Leave blank to keep current password')
			                     : _('Wi-Fi Password'),
		});

		/* 开放网络：不设密码。勾选后密码框置灰并清空，后端用 open 标记落盘 */
		var openCb = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		openCb.checked = (g.enabled === true && !hasKey);

		function syncOpen() {
			var on = openCb.checked;

			keyEl.disabled = on;
			keyEl.style.opacity = on ? '0.45' : '';
			if (on) {
				keyEl.value = '';
				keyEl.placeholder = _('No password (open network)');
			}
			else {
				keyEl.placeholder = hasKey ? _('Leave blank to keep current password')
				                           : _('Wi-Fi Password');
			}
		}
		openCb.addEventListener('change', syncOpen);
		syncOpen();

		/* 限速：0 = 不限制；保留后端已有的非标准值，避免下拉框回落到 0 */
		var bwList = [ 0, 1, 2, 5, 10, 20, 50, 100 ];
		var bwVal = g.bandwidth || 0;
		if (bwVal > 0 && bwList.indexOf(bwVal) < 0) bwList.push(bwVal);
		var bwSel = E('select', { 'class': 'cbi-input-select' },
			bwList.map(function(v) {
				return E('option', { value: '' + v },
					v ? v + ' Mbps' : _('Unlimited'));
			}));
		bwSel.value = '' + bwVal;

		var schedSel = E('select', { 'class': 'cbi-input-select' }, [
			E('option', { value: '0' }, _('All day')),
			E('option', { value: '1' }, _('Custom time window')),
		]);
		schedSel.value = g.schedule ? '1' : '0';

		var startEl = E('input', { type: 'time', 'class': 'cbi-input-text' });
		startEl.value = g.start || '08:00';
		var endEl = E('input', { type: 'time', 'class': 'cbi-input-text' });
		endEl.value = g.end || '23:00';

		function syncSched() {
			var custom = (schedSel.value === '1');
			startEl.disabled = !custom;
			endEl.disabled = !custom;
			startEl.style.opacity = endEl.style.opacity = custom ? '' : '0.45';
		}
		schedSel.addEventListener('change', syncSched);
		syncSched();

		var allowCb = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		allowCb.checked = (g.allow_lan === true);

		var openHint = (g.enabled && g.schedule && g.open === false)
			? E('div', { 'class': 'wr-hint' },
				_('Guest network is currently closed (outside the allowed time window).'))
			: null;

		var fields = E('div', {}, [
			E('div', { 'class': 'wr-guest-row' }, [
				E('label', {}, _('Wi-Fi Name (SSID)')),
				E('div', { 'class': 'wr-guest-ctrl' }, [ ssidEl ]),
			]),
			E('div', { 'class': 'wr-guest-row' }, [
				E('label', {}, _('Wi-Fi Password')),
				E('div', { 'class': 'wr-guest-ctrl' }, [
					keyEl,
					E('label', {
						style: 'display:inline-flex;align-items:center;gap:0.35em;margin-left:0.7em;white-space:nowrap'
					}, [ openCb, _('Open (no password)') ]),
				]),
				E('div', { 'class': 'wr-hint' },
					_('At least 8 characters. Leave blank to keep the current password.')),
			]),
			E('div', { 'class': 'wr-guest-row' }, [
				E('label', {}, _('Speed Limit')),
				E('div', { 'class': 'wr-guest-ctrl' }, [ bwSel ]),
				E('div', { 'class': 'wr-hint' },
					_('Downstream limit for each guest device.')),
			]),
			E('div', { 'class': 'wr-guest-row' }, [
				E('label', {}, _('Allowed Time')),
				E('div', { 'class': 'wr-guest-ctrl' },
					[ schedSel, startEl, E('span', {}, ' \u2014 '), endEl ]),
				E('div', { 'class': 'wr-hint' },
					_('The guest SSID is turned off outside this window.')),
			]),
			E('div', { 'class': 'wr-guest-row' }, [
				E('label', {}, _('Allow access to internal network')),
				E('div', { 'class': 'wr-guest-ctrl' }, [ allowCb ]),
				E('div', { 'class': 'wr-hint' },
					_('Off by default: guests can access the internet only.')),
			]),
			openHint,
		]);
		fields.style.display = cb.checked ? '' : 'none';
		cb.addEventListener('change', function() {
			fields.style.display = cb.checked ? '' : 'none';
		});

		var btn = E('button', {
			'class': 'btn cbi-button-positive',
			click: function() {
				self.applyGuest({
					cb: cb, ssidEl: ssidEl, keyEl: keyEl, openCb: openCb, bwSel: bwSel,
					schedSel: schedSel, startEl: startEl, endEl: endEl,
					allowCb: allowCb,
				}, btn, resBox);
			},
		}, _('Save Guest Network'));

		var resBox = E('div', { 'class': 'wr-hint' },
			g.last ? this.renderWifiResults(g.last.results) : '');

		var panel = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Guest Network')),
			E('div', { 'class': 'wr-guest-row wr-guest-head' }, [
				E('label', {}, _('Guest Network')),
				E('div', { 'class': 'wr-guest-ctrl' }, [ cb ]),
			]),
			fields,
			E('div', { 'class': 'wr-form-row' }, [
				isCap ? btn : E('div', { 'class': 'wr-hint' },
					_('Guest network can only be changed on the main AP.')),
				E('div', { 'class': 'wr-hint' },
					_('Applies to all paired APs. The guest SSID restarts after saving.')),
			]),
			resBox,
		]);

		if (!isCap) {
			wr.setFormDisabled(panel, true);
			resBox.textContent = '';
		}
		return panel;
	},

	applyGuest: function(form, btn, resBox) {
		var self = this;
		var g = this.guest || {};
		var on = !!form.cb.checked;
		var ssid = (form.ssidEl.value || '').trim();
		var openNet = !!form.openCb.checked;
		var key = openNet ? '' : (form.keyEl.value || '');

		if (on) {
			if (!ssid || ssid.length > 32) {
				wr.notify('warning', _('SSID must be 1-32 characters'));
				return;
			}
			if (!openNet) {
				if (key !== '' && key.length < 8) {
					wr.notify('warning', _('Password must be at least 8 characters'));
					return;
				}
				if (key === '' && g.has_key !== true) {
					wr.notify('warning',
						_('Please set a Wi-Fi password, or tick "Open (no password)"'));
					return;
				}
			}
		}

		wr.setBusy(btn, true, _('Applying...'));

		wr.call('set_guest', {
			enabled: on,
			ssid: ssid,
			key: key,
			open: openNet,
			bandwidth: parseInt(form.bwSel.value, 10) || 0,
			schedule: (form.schedSel.value === '1'),
			start: form.startEl.value || '08:00',
			end: form.endEl.value || '23:00',
			allow_lan: !!form.allowCb.checked,
		}).then(function(res) {
			wr.setBusy(btn, false);
			if (!res || !res.ok) {
				var why = res && res.error;
				wr.notify('danger', _('Failed') + ': ' +
					(why === 'not_cap' ? _('Only the main AP can change guest network settings')
					 : why === 'ssid_invalid' ? _('SSID must be 1-32 characters')
					 : why === 'key_invalid' ? _('Password must be at least 8 characters')
					 : why === 'time_invalid' ? _('Invalid time window')
					 : (why || 'unknown')));
				return;
			}

			/* 记住本次写入，避免二次保存时误判「没有旧密码」 */
			self.guest = self.guest || {};
			if (openNet) self.guest.has_key = false;
			else if (key !== '') self.guest.has_key = true;
			self.guest.enabled = on;
			self.guest.ssid = ssid;
			self.guest.bandwidth = parseInt(form.bwSel.value, 10) || 0;
			self.guest.schedule = (form.schedSel.value === '1');
			self.guest.start = form.startEl.value || '08:00';
			self.guest.end = form.endEl.value || '23:00';
			self.guest.allow_lan = !!form.allowCb.checked;

			form.keyEl.value = '';
			if (resBox) dom.content(resBox, self.renderWifiResults(res.results));
			self.refreshGuestResults(resBox);
			wr.notify('success',
				_('Guest network updated. The guest SSID restarts in a few seconds.'));
		}).catch(function() {
			wr.setBusy(btn, false);
			wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
		});
	},

	/* 短轮询：等成员 AP 回传访客配置结果，最多 6 次（约 15 秒） */
	refreshGuestResults: function(resBox) {
		var self = this;
		var tries = 0;

		function tick() {
			tries++;
			wr.safeCall('get_guest').then(function(st) {
				if (!st || !st.last || !resBox) return;
				dom.content(resBox, self.renderWifiResults(st.last.results));
				var pending = (st.last.results || []).some(function(r) {
					return r.ok === null || r.ok === undefined;
				});
				if (pending && tries < 6)
					window.setTimeout(tick, 2500);
			});
		}
		window.setTimeout(tick, 2500);
	},

	offloadGuestNotice: function(off) {
		switch (off.guest_guard) {
		case 'protected': return _('访客流量已排除在防火墙转发加速之外。');
		case 'unsupported': return _('当前防火墙版本未适配访客限速。开启加速时，访客可能绕过限速。');
		case 'apply_failed': return _('未能应用访客卸载排除，请检查系统日志。全局加速设置未被自动关闭。');
		case 'pending': return _('正在确认访客限速的卸载排除状态。');
		default: return '';
		}
	},

	/* 硬件加速（flow offloading）开关：本机实时生效。
	   开启后已建立的连接由 fw4 flowtable 转发，吞吐更高但不再经过防火墙规则。 */
	renderOffload: function() {
		var self = this;
		var off = this.offload || {};
		var managed = (this.st && this.st.role === 'sap') || off.managed === true;
		var now = E('span', { id: 'wr-offload-now', 'class': 'wr-hint' },
			off.enabled ? _('Currently on') : _('Currently off'));
		const guestNotice = E('div', { 'class': 'wr-hint', 'aria-live': 'polite' },
			this.offloadGuestNotice(off));

		var cb = E('input', {
			id: 'wr-offload-cb',
			type: 'checkbox', 'class': 'wr-switch-input',
			change: function(ev) {
				if (managed)
					return;

				var want = ev.target.checked;
				ev.target.disabled = true;

				wr.call('set_offload', { enabled: want }).then(function(res) {
					if (!res || !res.ok) {
						ev.target.checked = !want;
						wr.notify('danger', _('Failed') + ': ' +
							((res && res.error) || _('unknown')));
						return;
					}
					wr.notify('success', want
						? _('Hardware acceleration enabled')
						: _('Hardware acceleration disabled'));
					/* 以服务端实际状态为准回填，避免界面与内核 flowtable 不一致 */
					return wr.safeCall('offload_status').then(function(st) {
						if (st) self.offload = st;
						cb.checked = st ? !!st.enabled : want;
						if (st) self.refreshOffload();
					});
				}).catch(function() {
					ev.target.checked = !want;
					wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
				}).then(function() {
					ev.target.disabled = managed;
				});
			},
		});

		/* LuCI 的 E() 把布尔属性按字符串写入 DOM（checked:false 会变成
		   checked="false"，浏览器仍视为勾选），所以必须在创建后设置 property */
		cb.checked = !!off.enabled;
		cb.disabled = managed;
		this.offloadEls = { cb, now, guestNotice };

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Hardware Acceleration (flow offloading)')),
			E('div', { 'class': 'wr-form-row' }, [
				E('label', {}, [ cb, ' ',
					managed ? _('由主路由控制') : _('Enable flow offloading') ]),
				E('div', { 'class': 'wr-hint' },
					managed
						? _('硬件加速由主路由统一控制，子路由会跟随主路由状态。')
						: _('When enabled, established connections are handled by the flowtable for higher throughput; disable it if all traffic must pass through firewall rules.')),
				E('div', { 'class': 'wr-hint' }, [
					_('Applies to all paired APs.'), ' ', now,
				]),
				guestNotice,
			]),
		]);
	},

	refreshOffload: function() {
		var off = this.offload || {};
		if (!this.offloadEls)
			return;

		var managed = (this.st && this.st.role === 'sap') || off.managed === true;
		this.offloadEls.cb.checked = !!off.enabled;
		this.offloadEls.cb.disabled = managed;
		dom.content(this.offloadEls.now,
			off.enabled ? _('Currently on') : _('Currently off'));
		const notice = this.offloadGuestNotice(off);
		if (this.offloadEls.guestNotice.textContent !== notice) {
			dom.content(this.offloadEls.guestNotice, notice);
		}
	},

	isCap: function() {
		return !!(this.st && this.st.role === 'cap');
	},

	/* ---------------------------------------------------------- 组网管理 */
	/* 原「组网管理」页内容并入无线设置：本机角色、发现新设备、成员 AP 管理 */

	normMac: function(m) {
		return (m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
	},

	/* 该 MAC 是否已作为成员 AP 出现在拓扑中 */
	isMember: function(mac) {
		var nm = this.normMac(mac);
		var nodes = (this.topo && this.topo.nodes) || [];

		for (var i = 0; i < nodes.length; i++) {
			if (nodes[i].type !== 'ap')
				continue;
			if (this.normMac(nodes[i].mac || nodes[i].id) === nm)
				return true;
		}

		return false;
	},

	/* 配对轮询只需状态和拓扑，并给单次 RPC 加短超时，避免服务重启时卡住轮询 */
	fetchPairData: function() {
		var self = this;

		function call(method) {
			return Promise.race([
				wr.safeCall(method).catch(function() { return null; }),
				new Promise(function(resolve) {
					window.setTimeout(function() { resolve(null); }, 1200);
				}),
			]);
		}

		return Promise.all([ call('status'), call('topology') ]).then(function(res) {
			if (res[0]) self.st = res[0];
			if (res[1]) self.topo = res[1];
		});
	},

	/* 拉一次数据；render=false 时不重建 DOM（配对轮询期间用，避免按钮状态被刷掉） */
	fetchData: function(render) {
		var self = this;

		return Promise.all([
			wr.safeCall('status'),
			wr.safeCall('discover'),
			wr.safeCall('topology'),
			wr.safeCall('offload_status'),
		]).then(function(res) {
			if (res[0]) self.st = res[0];
			if (res[1]) self.disc = res[1];
			if (res[2]) self.topo = res[2];
			if (res[3]) self.offload = res[3];

			var sb = document.getElementById('wr-status');
			if (sb && self.st)
				dom.content(sb, wr.statusBar(self.st));

			self.refreshOffload();

			if (render !== false && !self.actionBusy)
				self.renderBody();

			return res;
		});
	},

	refresh: function() {
		return this.fetchData(true);
	},

	renderBody: function() {
		var box = document.getElementById('wr-pair-body');
		if (box) dom.content(box, this.buildBody());
	},

	/* 把后端错误码翻成人话 */
	errText: function(code) {
		switch (code) {
		case 'not_cap':           return _('this device is not the main AP');
		case 'not_found':         return _('device not found (it may have gone offline)');
		case 'no_ip':             return _('device has no IP address yet');
		case 'socket':            return _('cannot open control connection to the device');
		case 'sap_via_pairing':   return _('sub APs must be added by pairing from the main AP');
		case 'invalid_mac':       return _('invalid MAC address');
		case 'timeout':           return _('timed out');
		case 'cap_controlled':    return _('硬件加速由主路由控制');
		case 'no_firewall_defaults': return _('没有找到防火墙配置');
		case 'unknown':           return _('未知错误');
		}
		return code || _('request rejected');
	},

	/* ------------------------------------------------------------ actions */

	pairDevice: function(d, btn) {
		var self = this;

		if (this.actionBusy) return;

		this.actionBusy = true;
		wr.setBusy(btn, true, _('Pairing...'));
		var notice = wr.busyOverlay(
			_('正在添加子路由并重启服务，请勿刷新页面……'));

		return wr.call('pair', { mac: d.mac }).then(function(res) {
			if (!res || !res.ok) {
				wr.notify('danger', _('Pair failed') + ': ' +
					self.errText(res && res.error));
				return;
			}

			wr.notify('info', _('Pairing request sent to') + ' ' + (d.ip || d.mac) +
				' — ' + _('waiting for the device to join...'));

			/* 配对后主路由服务若被重启掉，首页会自动拉起 */
			try { sessionStorage.setItem('wr_service_autostart', '1'); } catch (e) {}

			/* 后端是异步确认的，这里主动探测直到它出现在拓扑里 */
			return wr.pollUntil(function() {
				return self.fetchPairData().then(function() {
					return self.isMember(d.mac);
				});
			}, 800, 45000).then(function(joined) {
				if (joined) {
					wr.notify('success', _('Device paired successfully'));
				}
				else {
					wr.notify('warning',
						_('Device did not join in time. Make sure it is powered on and connected to the same LAN.'));
				}
			});
		}).catch(function() {
			wr.notify('danger', _('Pair failed') + ': ' + _('request rejected'));
		}).then(function() {
			self.actionBusy = false;
			/* 配对确认后立即撤掉遮罩，列表在后台刷新，避免服务重启时长时间遮挡 */
			if (notice) notice();
			return self.refresh().catch(function() {});
		});
	},

	unpairDevice: function(a, btn) {
		var self = this;

		if (this.actionBusy) return;
		if (!confirm(_('Remove this AP from the network?'))) return;

		this.actionBusy = true;
		wr.setBusy(btn, true, _('Removing...'));

		return wr.call('unpair', { mac: a.mac }).then(function(res) {
			if (res && res.ok === false) {
				wr.notify('danger', _('Remove failed') + ': ' + self.errText(res.error));
				return;
			}

			wr.notify('info', _('AP removed'));

			return wr.pollUntil(function() {
				return self.fetchData(false).then(function() {
					return !self.isMember(a.mac);
				});
			}, 1500, 15000);
		}).catch(function() {
			wr.notify('danger', _('Remove failed') + ': ' + _('request rejected'));
		}).then(function() {
			self.actionBusy = false;
			return self.refresh();
		});
	},

	setRole: function(role, btn) {
		var self = this;
		var ok = false;

		if (this.actionBusy) return;
		if (role === 'unconfigured' &&
		    !confirm(_('Reset this device to unconfigured state?')))
			return;

		this.actionBusy = true;
		wr.setBusy(btn, true, _('Applying...'));
		var notice = (role === 'cap')
			? wr.busyOverlay(_('正在切换为主路由并重启服务，请勿刷新页面……'))
			: null;

		return wr.call('set_role', { role: role }).then(function(res) {
			if (res && res.ok === false) {
				wr.notify('danger', _('Failed') + ': ' + self.errText(res.error));
				return;
			}

			wr.notify('success', role === 'cap'
				? _('This device is now the main AP (CAP)')
				: _('This device is now unconfigured'));
			ok = true;
		}).catch(function() {
			wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
		}).then(function() {
			self.actionBusy = false;

			if (role === 'cap' && ok) {
				/* 服务若被重启掉，首页会自动拉起 */
				try { sessionStorage.setItem('wr_service_autostart', '1'); } catch (e) {}

				/* 等无线重启完成后整页刷新，遮罩随刷新一起消失 */
				return new Promise(function(resolve) {
					window.setTimeout(resolve, 4000);
				}).then(function() {
					window.location.reload();
				});
			}

			return self.refresh().catch(function() {}).then(function() {
				if (notice) notice();
			});
		});
	},

	/* ------------------------------------------------------- pairing render */

	buildBody: function() {
		var self = this;
		var st = this.st || {};
		var isCap = st.role === 'cap';
		var frag = E('div', {});

		// ---- role card ----
		var roleRows = [
			E('tr', {}, [ E('td', {}, _('Role')), E('td', {}, wr.roleBadge(st.role)) ]),
			E('tr', {}, [ E('td', {}, _('Device Name')), E('td', {}, st.name || '-') ]),
			E('tr', {}, [ E('td', {}, _('Model')), E('td', {}, st.model || '-') ]),
			E('tr', {}, [ E('td', {}, _('Firmware')), E('td', {}, st.firmware || '-') ]),
		];
		if (st.role === 'sap')
			roleRows.push(E('tr', {}, [ E('td', {}, _('Main AP')), E('td', {}, st.cap_ip || '-') ]));

		var roleCard = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('This Device')),
			E('table', { 'class': 'table wr-detail-table' }, roleRows),
		]);

		if (st.role === 'unconfigured') {
			var setCapBtn = E('button', {
				'class': 'btn cbi-button-positive',
				click: function() { return self.setRole('cap', setCapBtn); },
			}, _('Set as Main AP (CAP)'));

			roleCard.appendChild(E('div', { style: 'margin-top:0.8em' }, [
				setCapBtn,
				E('div', { 'class': 'wr-hint' },
					_('Or keep it unconfigured and pair it from an existing main AP.')),
			]));
		}
		else if (isCap) {
			var resetBtn = E('button', {
				'class': 'btn cbi-button-negative',
				click: function() { return self.setRole('unconfigured', resetBtn); },
			}, _('Reset Role'));

			roleCard.appendChild(E('div', { style: 'margin-top:0.8em' }, [
				resetBtn,
				E('div', { 'class': 'wr-hint' },
					_('Resetting clears the network token; member APs must be paired again.')),
			]));
		}
		else if (st.role === 'sap') {
			var resetSapBtn = E('button', {
				'class': 'btn cbi-button-negative',
				click: function() { return self.setRole('unconfigured', resetSapBtn); },
			}, _('重置为未配置'));

			roleCard.appendChild(E('div', { style: 'margin-top:0.8em' }, [
				resetSapBtn,
				E('div', { 'class': 'wr-hint' },
					_('重置会清除配对信息，之后需要由主 AP 重新配对。')),
			]));
		}

		frag.appendChild(roleCard);

		if (!isCap) {
			frag.appendChild(E('div', { 'class': 'alert-message info' },
				_('Pairing and member management are done on the main AP (CAP).')));
			return frag;
		}

		// ---- discovered devices ----
		var devices = (this.disc && this.disc.devices) || [];
		var discRows = devices.map(function(d) {
			var pairBtn = E('button', {
				'class': 'btn cbi-button-positive',
				click: function() { return self.pairDevice(d, pairBtn); },
			}, _('Pair'));

			return E('tr', {}, [
				E('td', {}, d.name || '-'),
				E('td', {}, d.model || '-'),
				E('td', { style: 'font-family:monospace' }, d.mac || d.id || '-'),
				E('td', {}, d.ip || '-'),
				E('td', {}, wr.fmtAge(d.last_seen)),
				E('td', {}, pairBtn),
			]);
		});

		var discTable = E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', {}, _('Name')), E('th', {}, _('Model')),
				E('th', {}, _('MAC')), E('th', {}, _('IP')),
				E('th', {}, _('Last Seen')), E('th', {}, ''),
			]),
		].concat(discRows.length ? discRows : [
			E('tr', { 'class': 'tr placeholder' }, [
				E('td', { colspan: 6 },
					_('未发现新设备。请确认对端已安装插件、插件服务正在运行，并与本机处于同一网段；若对端已配对过，请先在对端重置角色。')),
			]),
		]));

		frag.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Discovered New Devices')), discTable,
		]));

		// ---- member APs ----
		var topo = this.topo || {};
		var nodes = topo.nodes || [];
		var members = nodes.filter(function(n) {
			return n.type === 'ap' && n.id !== topo.self;
		});

		var memberRows = members.map(function(a) {
			var rmBtn = E('button', {
				'class': 'btn cbi-button-negative',
				click: function() { return self.unpairDevice(a, rmBtn); },
			}, _('Remove'));

			return E('tr', {}, [
				E('td', {}, a.name || '-'),
				E('td', {}, a.ip || '-'),
				E('td', {}, a.model || '-'),
				E('td', {}, a.uplink
					? (a.uplink.type === 'wired' ? _('Wired') : _('Wireless'))
					: '-'),
				E('td', {}, '' + ((a.clients || []).length)),
				E('td', {}, rmBtn),
			]);
		});

		var memberTable = E('table', { 'class': 'table cbi-section-table' }, [
			E('tr', { 'class': 'tr table-titles' }, [
				E('th', {}, _('Name')), E('th', {}, _('IP')), E('th', {}, _('Model')),
				E('th', {}, _('Backhaul')), E('th', {}, _('Clients')), E('th', {}, ''),
			]),
		].concat(memberRows.length ? memberRows : [
			E('tr', { 'class': 'tr placeholder' }, [
				E('td', { colspan: 6 }, _('No member APs yet')),
			]),
		]));

		frag.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Member APs')), memberTable,
		]));

		return frag;
	},

	render: function(data) {
		this.st = data[0] || {};
		this.offload = data[1] || {};
		this.wifi = data[2] || {};
		this.guest = data[3] || {};
		this.disc = data[4];
		this.topo = data[5];

		wr.mountNav('settings', {
			running: !!(this.st && this.st.role),
			role: this.st && this.st.role,
		});

		poll.add(L.bind(this.refresh, this), 10);

		if (!this.st || !this.st.role) {
			return E('div', {}, [
				wr.css(),
				E('h2', {}, _('无线设置')),
				E('div', { class: 'alert-message danger' },
					_('无法连接 wifiroamd，请先在首页启动插件服务，然后刷新本页。')),
			]);
		}

		return E('div', { id: 'wr-set' }, [
			wr.css(),
			E('h2', {}, _('无线设置')),
			E('div', { id: 'wr-status' }, wr.statusBar(this.st || {})),
			this.renderWifiPanel(),
			this.renderGuestPanel(),
			this.renderOffload(),
			E('div', { id: 'wr-pair-body' }, this.buildBody()),
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
