// wifiroam home view: network overview and plugin service control
'use strict';
'require view';
'require ui';
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
var REQUIRED_VERSION = 5;

return view.extend({
	st: null,
	svc: null,
	rclist: null,
	loaded: false,
	rcLoaded: false,
	busy: false,
	actionStarted: false,
	svcBtns: null,
	autoCb: null,

	/* Render immediately; status/service RPCs can be slow (rc.list scans
	   every init script), so they are filled in after the first paint. */
	load: function() {
		return null;
	},

	hydrate: function() {
		var self = this;

		/* 三个来源分开返回：service.list 先到就先点亮服务面板，
		   rc.list 较慢只影响开机自启勾选，不阻塞状态显示。 */
		var serviceP = callServiceList('wifiroam').catch(function() { return null; })
			.then(function(svc) {
				if (self.actionStarted)
					return;
				self.svc = svc;
				self.loaded = true;
				self.applyServiceState();
				self.updateVersionDom();
			});

		var statusP = wr.safeCall('status').then(function(st) {
			if (self.actionStarted)
				return;
			self.st = st || {};
			self.updateStatusDom();
			self.updateVersionDom();
		});

		var rcP = callRcList().catch(function() { return null; })
			.then(function(rc) {
				if (self.actionStarted)
					return;
				self.rclist = rc;
				self.rcLoaded = true;
				self.applyServiceState();
			});

		poll.add(function() { return self.refreshService(false); }, 15);

		return Promise.all([ serviceP, statusP, rcP ]);
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

	versionText: function() {
		if (!this.loaded)
			return _('正在读取服务状态...');

		var ver = this.st && this.st.version;
		var text = ver != null ? _('守护进程版本') + ': ' + ver : '';

		if (this.versionStale())
			text = text ? text + ' · ' + _('与前端不一致，点击重启可修复')
			            : _('与前端不一致，点击重启可修复');

		return text;
	},

	updateVersionDom: function() {
		var el = document.getElementById('wr-svc-version');
		if (el)
			el.textContent = this.versionText();
	},

	applyServiceState: function() {
		if (!this.loaded || this.busy)
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

		if (this.autoCb) {
			this.autoCb.disabled = !this.rcLoaded;
			this.autoCb.checked = this.svcEnabled();
		}
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
			if (full !== false) {
				self.rclist = res[1];
				self.rcLoaded = true;
			}
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

	navOptions: function() {
		return {
			running: !!(this.st && this.st.role),
			role: (this.st && this.st.role) || '',
		};
	},

	updateNavTabs: function() {
		wr.mountNav('home', this.navOptions());
	},

	updateStatusDom: function() {
		var sb = document.getElementById('wr-status');
		if (sb)
			dom.content(sb, wr.statusBar(this.st || {}));

		var warn = document.getElementById('wr-home-warn');
		if (warn)
			warn.style.display = (this.st && this.st.role) ? 'none' : '';

		this.updateNavTabs();
	},

	afterServiceChange: function(repaired, action) {
		var self = this;

		this.loaded = true;

		return self.refreshService().then(function() {
			return wr.safeCall('status');
		}).then(function(st) {
			self.st = st || {};
			self.updateStatusDom();
			self.updateVersionDom();

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
		this.actionStarted = true;

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
	/* 打赏入口弹窗：微信支付二维码 + 联系方式 */
	openDonate: function() {
		ui.showModal('用得爽，打个赏', [
			E('div', { 'class': 'wr-donate-body' }, [
				E('img', { src: L.resource('wifiroam/donate-qr.png'), alt: 'donate qr' }),
				E('p', {}, '感谢您的认可，打赏用户有任何需求可发送至邮箱 1823774778@qq.com')
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn',
					click: function() { ui.hideModal(); }
				}, '关闭')
			])
		]);
	},

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
		auto.disabled = !this.loaded;
		auto.addEventListener('change', function() {
			self.toggleAutostart(auto.checked);
		});
		this.autoCb = auto;

		var running = this.loaded && this.svcRunning();
		var badgeCls = !this.loaded ? 'wr-badge-unconfigured'
		                              : (running ? 'wr-badge-on' : 'wr-badge-off');
		var badgeText = !this.loaded ? _('读取中...')
		                             : (running ? _('运行中') : _('已停止'));

		var panel = E('div', { id: 'wr-svc', 'class': 'cbi-section' }, [
			E('h3', {}, _('插件服务')),
			E('div', { 'class': 'wr-svc-row' }, [
				E('span', {
					id: 'wr-svc-badge',
					'class': 'wr-badge ' + badgeCls,
				}, badgeText),
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
			E('div', { 'class': 'wr-hint', id: 'wr-svc-version' }, this.versionText()),
		]);

		this.applyServiceState();

		/* 服务状态还没回来时至少让「启动」可点，避免页面看似卡死 */
		if (!this.loaded) {
			btns.start.disabled = false;
			btns.stop.disabled = true;
			btns.restart.disabled = false;
		}

		return panel;
	},

	render: function() {
		this.st = {};
		this.svc = null;
		this.rclist = null;
		this.loaded = false;
		this.rcLoaded = false;
		this.busy = false;
		this.actionStarted = false;

		/* 先把页面画出来，状态类 RPC 在首屏后异步补齐 */
		window.setTimeout(L.bind(this.hydrate, this), 0);

		/* 页签挂在 #view 外，先用上次状态（没有则展示全部）即时渲染 */
		wr.mountNav('home');

		return E('div', { id: 'wr-home' }, [
			wr.css(),
			E('h2', {}, [
				_('首页'),
				E('a', {
					'class': 'wr-donate-btn',
					click: L.bind(this.openDonate, this)
				}, '用得爽，打个赏')
			]),
			E('div', { id: 'wr-status' },
				E('div', { 'class': 'wr-hint' }, _('正在读取网络状态...'))),
			E('div', {
				id: 'wr-home-warn',
				'class': 'alert-message warning',
				style: 'display:none',
			}, _('无法连接 wifiroamd。请使用下方插件服务控制启动它。')),
			this.renderServicePanel(),
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null,
});
