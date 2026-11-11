// wifiroam home view: network overview and plugin service control
'use strict';
'require view';
'require poll';
'require dom';
'require rpc';
'require wifiroam.common as wr';

var callServiceList = rpc.declare({
	object: 'service', method: 'list', params: [ 'name' ], expect: { '': {} },
});
var callRcList = rpc.declare({
	object: 'rc', method: 'list', expect: { '': {} },
});
var callRcInit = rpc.declare({
	object: 'rc', method: 'init', params: [ 'name', 'action' ],
});

/* Keep in sync with DAEMON_VERSION in wifiroamd.uc */
var REQUIRED_VERSION = 3;

return view.extend({
	st: null,
	svc: null,
	rclist: null,
	busy: false,
	svcBtns: null,
	autoCb: null,

	load: function() {
		return Promise.all([
			wr.safeCall('status'),
			callServiceList('wifiroam').catch(function() { return null; }),
			callRcList().catch(function() { return null; }),
		]);
	},

	/* ------------------------------------------------------ service state */
	svcRunning: function() {
		var s = this.svc && this.svc.wifiroam;
		var inst = (s && s.instances) || {};

		for (var k in inst)
			if (inst[k] && inst[k].running)
				return true;

		return false;
	},

	svcEnabled: function() {
		var r = this.rclist && this.rclist.wifiroam;
		return !!(r && r.enabled);
	},

	versionStale: function() {
		return !!(this.st && this.st.role && this.st.version !== REQUIRED_VERSION);
	},

	applyServiceState: function() {
		if (this.busy)
			return;

		var running = this.svcRunning();
		var badge = document.getElementById('wr-svc-badge');

		if (badge) {
			badge.textContent = running ? _('运行中') : _('已停止');
			badge.className = 'wr-badge ' + (running ? 'wr-badge-on' : 'wr-badge-off');
		}

		if (this.svcBtns) {
			if (this.svcBtns.start) this.svcBtns.start.disabled = running;
			if (this.svcBtns.stop) this.svcBtns.stop.disabled = !running;
			if (this.svcBtns.restart) this.svcBtns.restart.disabled = false;
		}

		if (this.autoCb)
			this.autoCb.checked = this.svcEnabled();
	},

	refreshService: function(full) {
		var self = this;
		var jobs = [
			callServiceList('wifiroam').catch(function() { return null; }),
		];

		if (full !== false)
			jobs.push(callRcList().catch(function() { return null; }));

		return Promise.all(jobs).then(function(res) {
			self.svc = res[0];
			if (full !== false)
				self.rclist = res[1];
			self.applyServiceState();
		});
	},

	waitServiceState: function(want) {
		var self = this;

		return wr.pollUntil(function() {
			return callServiceList('wifiroam').catch(function() { return null; })
				.then(function(svc) {
					self.svc = svc;
					return self.svcRunning() === want;
				});
		}, 1000, 15000);
	},

	/* Restart left an old daemon running: force stop + start and re-check. */
	repairIfStale: function() {
		function ready() {
			return wr.safeCall('status').then(function(st) {
				return !!(st && st.version === REQUIRED_VERSION);
			});
		}

		return wr.pollUntil(ready, 1000, 8000).then(function(ok) {
			if (ok)
				return null;

			return callRcInit('wifiroam', 'stop').catch(function() { return null; })
				.then(function() {
					return new Promise(function(resolve) {
						window.setTimeout(resolve, 800);
					});
				})
				.then(function() {
					return callRcInit('wifiroam', 'start').catch(function() { return null; });
				})
				.then(function() {
					return wr.pollUntil(ready, 1000, 15000);
				})
				.then(function(ok2) {
					return !!ok2;
				});
		});
	},

	updateStatusDom: function() {
		var sb = document.getElementById('wr-status');
		if (sb)
			dom.content(sb, wr.statusBar(this.st || {}));

		var warn = document.getElementById('wr-home-warn');
		if (warn)
			warn.style.display = (this.st && this.st.role) ? 'none' : '';
	},

	afterServiceChange: function(repaired, action) {
		var self = this;

		return self.refreshService().then(function() {
			return wr.safeCall('status');
		}).then(function(st) {
			self.st = st || {};
			self.updateStatusDom();

			if (repaired === false)
				wr.notify('danger', _('版本不一致，自动修复失败，请重新安装插件包。'));
			else if (action === 'stop')
				wr.notify('success', _('插件服务已停止。'));
			else
				wr.notify('success', _('插件服务已启动。'));
		});
	},

	serviceAction: function(action) {
		var self = this;

		if (this.busy)
			return Promise.resolve();

		this.busy = true;

		var btn = this.svcBtns ? this.svcBtns[action] : null;
		wr.setBusy(btn, true, _('处理中...'));

		return callRcInit('wifiroam', action).then(function(rc) {
			if (rc)
				throw new Error(_('命令执行失败'));

			var want = (action !== 'stop');
			return self.waitServiceState(want).then(function(ok) {
				if (!ok)
					throw new Error(action === 'stop' ? _('服务未能停止') : _('服务未能启动'));

				if (action === 'restart')
					return self.repairIfStale();

				return null;
			});
		}).then(function(repaired) {
			self.busy = false;
			wr.setBusy(btn, false);
			return self.afterServiceChange(repaired, action);
		}).catch(function(e) {
			self.busy = false;
			wr.setBusy(btn, false);
			wr.notify('danger', _('服务操作失败') + ': ' +
				(e && e.message ? e.message : action));
			return self.refreshService();
		});
	},

	toggleAutostart: function(on) {
		var self = this;

		return callRcInit('wifiroam', on ? 'enable' : 'disable').then(function(rc) {
			if (rc)
				throw new Error(_('命令执行失败'));

			return self.refreshService();
		}).then(function() {
			wr.notify('info', on ? _('已设置开机自动启动。') : _('已取消开机自动启动。'));
		}).catch(function(e) {
			wr.notify('danger', _('设置失败') + ': ' +
				(e && e.message ? e.message : ''));
			return self.refreshService();
		});
	},

	/* -------------------------------------------------------- service UI */
	renderServicePanel: function() {
		var self = this;
		var btns = {};

		function actBtn(action, label, cls) {
			var b = E('button', {
				'class': 'btn ' + cls,
				click: function() { self.serviceAction(action); },
			}, label);

			btns[action] = b;
			return b;
		}

		this.svcBtns = btns;

		var auto = E('input', { type: 'checkbox', 'class': 'wr-switch-input' });
		auto.checked = this.svcEnabled();
		auto.addEventListener('change', function() {
			self.toggleAutostart(auto.checked);
		});
		this.autoCb = auto;

		var ver = this.st && this.st.version;
		var verText = ver != null ? _('守护进程版本') + ': ' + ver : '';

		if (this.versionStale())
			verText = verText ? verText + ' · ' + _('与前端不一致，点击重启可修复')
			                  : _('与前端不一致，点击重启可修复');

		var panel = E('div', { id: 'wr-svc', 'class': 'cbi-section' }, [
			E('h3', {}, _('插件服务')),
			E('div', { 'class': 'wr-svc-row' }, [
				E('span', {
					id: 'wr-svc-badge',
					'class': 'wr-badge ' + (this.svcRunning() ? 'wr-badge-on' : 'wr-badge-off'),
				}, this.svcRunning() ? _('运行中') : _('已停止')),
				E('span', { 'class': 'wr-hint' },
					_('wifiroamd 负责发现 AP 并下发漫游配置。')),
			]),
			E('div', { 'class': 'wr-toolbar' }, [
				actBtn('start', _('启动'), 'cbi-button-positive'),
				actBtn('stop', _('停止'), 'cbi-button-negative'),
				actBtn('restart', _('重启'), 'cbi-button-action'),
				E('label', { 'class': 'wr-svc-auto' }, [
					auto, ' ', _('开机自动启动'),
				]),
			]),
			E('div', { 'class': 'wr-hint', id: 'wr-svc-version' }, verText),
		]);

		this.applyServiceState();
		return panel;
	},

	render: function(data) {
		var self = this;

		this.st = data[0] || {};
		this.svc = data[1];
		this.rclist = data[2];
		this.busy = false;

		poll.add(function() { return self.refreshService(false); }, 15);

		var reachable = !!(this.st && this.st.role);

		return E('div', { id: 'wr-home' }, [
			wr.css(),
			wr.navTabs('home'),
			E('h2', {}, _('首页')),
			E('div', { id: 'wr-status' }, wr.statusBar(this.st || {})),
			E('div', {
				id: 'wr-home-warn',
				'class': 'alert-message warning',
				style: reachable ? 'display:none' : '',
			}, _('无法连接 wifiroamd。请使用下方插件服务控制启动它。')),
			this.renderServicePanel(),
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
