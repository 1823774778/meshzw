/*
 * wifiroam LuCI frontend - readable rewrite of luci-app-wifiroam 0.261115.15302.
 *
 * Only the dense one-line layout was re-laid-out (indentation, line breaks,
 * section notes). No logic, text, class name, element id, ubus call,
 * parameter, polling interval or button action was changed.
 */
'use strict';
'require view';
'require ui';
'require poll';
'require dom';
'require wifiroam.common as wr';
var RSSI_PRESETS = { aggressive: -62, balanced: -70, conservative: -78 };
return view.extend({
    cfg: null,
    pre: undefined,
    st: null,
    bh: null,
    els: null,
    busy: false,
    load: function () {
        return Promise.all([
            wr.safeCall('get_roam'),
            wr.safeCall('status'),
            wr.safeCall('appctl_status'),
        ]);
    },
    hydrate: function () {
        var self = this;
        return Promise.all([wr.safeCall('precheck'), wr.safeCall('get_backhaul')])
            .then(function (res) {
                self.pre = res[0] != null ? res[0] : null;
                self.bh = res[1];
                var pre = document.getElementById('wr-pre');
                if (pre) dom.content(pre, self.renderChecklist());
                var bh = document.getElementById('wr-bh');
                if (bh) dom.content(bh, self.renderBackhaulPanel(self.isCap()));
            })
            .catch(function () {});
    },
    isCap: function () {
        return !!(this.st && this.st.role === 'cap');
    },
    checkLabel: function (c) {
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
    // ---- Pre-flight checks ----
    renderChecklist: function () {
        var self = this;
        if (this.pre === undefined)
            return E('div', { class: 'cbi-section' }, [
                E('h3', {}, _('Pre-flight Checks')),
                E('div', { class: 'wr-hint' }, _('Loading pre-flight checks...')),
            ]);
        if (!this.pre)
            return E('div', { class: 'cbi-section' }, [
                E('h3', {}, _('Pre-flight Checks')),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('Pre-flight checks unavailable (wifiroamd not reachable).'),
                ),
            ]);
        var role = this.pre.role || (this.st && this.st.role) || 'unconfigured';
        var isCap = role === 'cap';
        var items = (this.pre.checks || [])
            .filter(function (c) {
                return c.id !== 'role' || isCap;
            })
            .map(function (c) {
                return E(
                    'div',
                    { class: c.ok ? 'wr-check-ok' : 'wr-check-fail' },
                    (c.ok ? '\u2713 ' : '\u2717 ') + self.checkLabel(c),
                );
            });
        if (!items.length) items = [E('div', {}, _('No checks available'))];
        var roleHint = null;
        if (!isCap)
            roleHint = E(
                'div',
                { class: 'wr-check-info' },
                _(
                    'This device is not the main AP. Run pre-flight checks and roaming settings on the CAP.',
                ),
            );
        return E('div', { class: 'cbi-section' }, [
            E('h3', {}, _('Pre-flight Checks')),
            roleHint,
            E('div', {}, items),
            this.renderApTable(),
        ]);
    },
    renderApTable: function () {
        var aps = (this.pre && this.pre.aps) || [];
        if (!aps.length) return '';
        var self = this;
        var rows = aps.map(function (a) {
            return E('tr', {}, [
                E('td', {}, [
                    E('b', {}, a.name || a.id || '-'),
                    a.self ? E('span', { class: 'wr-hint' }, ' ' + _('(this device)')) : '',
                ]),
                E('td', {}, wr.roleBadge(a.role)),
                E('td', { style: 'font-family:monospace' }, a.ip || '-'),
                E(
                    'td',
                    { class: a.online ? 'wr-apply-ok' : 'wr-apply-fail' },
                    a.online ? _('Online') : _('Offline'),
                ),
                E('td', {}, self.kvrCell(self.kvrOf(a))),
                E('td', {}, a.ssids && a.ssids.length ? a.ssids.join(', ') : '-'),
            ]);
        });
        return E('div', { class: 'wr-ap-table' }, [
            E('h4', {}, _('Member APs')),
            E(
                'table',
                { class: 'table cbi-section-table' },
                [
                    E('tr', { class: 'tr table-titles' }, [
                        E('th', {}, _('AP')),
                        E('th', {}, _('Role')),
                        E('th', {}, _('IP')),
                        E('th', {}, _('Status')),
                        E('th', {}, _('R / K / V')),
                        E('th', {}, _('SSIDs')),
                    ]),
                ].concat(rows),
            ),
        ]);
    },
    kvrOf: function (a) {
        if (a && a.kvr) return a.kvr;
        var results = (this.st && this.st.last_apply && this.st.last_apply.results) || [];
        var id = ((a && a.id) || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
        for (var i = 0; i < results.length; i++) {
            var ap = (results[i].ap || '').replace(/[^0-9a-f]/gi, '').toLowerCase();
            if (ap && ap === id) return results[i].kvr || null;
        }
        return null;
    },
    kvrCell: function (k) {
        if (!k || !k.seen) return E('span', { class: 'wr-hint' }, '-');
        function tag(on, label) {
            return E(
                'span',
                {
                    class: 'wr-kvr ' + (on ? 'wr-kvr-on' : 'wr-kvr-off'),
                    title: on ? _('Effective') : _('Not effective'),
                },
                label,
            );
        }
        return E('span', {}, [tag(k.r, 'R'), ' ', tag(k.k, 'K'), ' ', tag(k.v, 'V')]);
    },
    resultCell: function (r) {
        if (r.ok === null || r.ok === undefined)
            return { cls: 'wr-apply-pending', text: _('Pending') };
        if (r.ok === true)
            return { cls: 'wr-apply-ok', text: _('OK') + (r.ver ? ' (v' + r.ver + ')' : '') };
        return { cls: 'wr-apply-fail', text: _('Failed') + (r.error ? ': ' + r.error : '') };
    },
    renderApplyResults: function (res) {
        if (!res || !res.results)
            return E('div', { class: 'wr-hint' }, _('No configuration has been applied yet.'));
        var pending = 0;
        var rows = res.results.map(function (r) {
            var s = this.resultCell(r);
            if (r.ok === null || r.ok === undefined) pending++;
            return E('tr', {}, [
                E('td', {}, r.name || r.ap || '-'),
                E('td', { style: 'font-family:monospace' }, r.ap || '-'),
                E('td', { class: s.cls }, s.text),
            ]);
        }, this);
        var head = _('Last Apply Result') + ' (v' + (res.ver || '?') + ')';
        if (pending) head += ' — ' + _('%d AP(s) still pending').format(pending);
        return E('div', { class: 'cbi-section' }, [
            E('h3', {}, head),
            E(
                'table',
                { class: 'table cbi-section-table' },
                [
                    E('tr', { class: 'tr table-titles' }, [
                        E('th', {}, _('AP')),
                        E('th', {}, _('MAC')),
                        E('th', {}, _('Result')),
                    ]),
                ].concat(rows),
            ),
        ]);
    },
    renderApply: function () {
        var box = document.getElementById('wr-apply');
        if (box) dom.content(box, this.renderApplyResults(this.st && this.st.last_apply));
    },
    refreshPre: function () {
        var self = this;
        return wr.safeCall('precheck').then(function (pre) {
            if (!pre) return;
            self.pre = pre;
            var box = document.getElementById('wr-pre');
            if (box) dom.content(box, self.renderChecklist());
        });
    },
    renderBackhaulResults: function (res) {
        if (!res || !res.results)
            return E('div', { class: 'wr-hint' }, _('No configuration has been applied yet.'));
        var pending = 0;
        var self = this;
        var rows = res.results.map(function (r) {
            var s = self.resultCell(r);
            if (r.ok === null || r.ok === undefined) pending++;
            return E('tr', {}, [
                E('td', {}, r.name || r.ap || '-'),
                E('td', { style: 'font-family:monospace' }, r.ap || '-'),
                E('td', { class: s.cls }, s.text),
            ]);
        });
        var head = _('Backhaul Apply Result') + ' (v' + (res.ver || '?') + ')';
        if (pending) head += ' — ' + _('%d AP(s) still pending').format(pending);
        return E('div', {}, [
            E('h4', {}, head),
            E(
                'table',
                { class: 'table cbi-section-table' },
                [
                    E('tr', { class: 'tr table-titles' }, [
                        E('th', {}, _('AP')),
                        E('th', {}, _('MAC')),
                        E('th', {}, _('Result')),
                    ]),
                ].concat(rows),
            ),
        ]);
    },
    renderBackhaulApply: function () {
        var box = document.getElementById('wr-bh-apply');
        if (box) dom.content(box, this.renderBackhaulResults(this.st && this.st.last_backhaul));
    },
    waitBackhaulResults: function (ver, timeout) {
        var self = this;
        return wr.pollUntil(
            function () {
                return wr.safeCall('status').then(function (st) {
                    if (!st || !st.last_backhaul || !st.last_backhaul.results) return false;
                    if (ver != null && st.last_backhaul.ver !== ver) return false;
                    self.st = st;
                    self.renderBackhaulApply();
                    return st.last_backhaul.results.every(function (r) {
                        return r.ok !== null && r.ok !== undefined;
                    });
                });
            },
            1500,
            timeout || 40000,
        );
    },
    applyBackhaul: function () {
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
        return wr
            .call('set_backhaul', {
                enabled: e.bhEnable.checked,
                ssid: ssid,
                key: key,
                device: e.bhDev.value || '',
            })
            .then(function (res) {
                if (!res || !res.ok) {
                    wr.notify(
                        'danger',
                        _('Apply failed') + ': ' + ((res && res.error) || _('request rejected')),
                    );
                    return;
                }
                self.st = self.st || {};
                self.st.last_backhaul = { ver: res.ver, results: res.results };
                self.renderBackhaulApply();
                if (res.backhaul && res.backhaul.key) e.bhKey.value = res.backhaul.key;
                wr.notify(
                    'info',
                    _('Backhaul configuration sent, waiting for member APs to confirm...'),
                );
                return self.waitBackhaulResults(res.ver).then(function (allDone) {
                    var bad = (self.st.last_backhaul.results || []).filter(function (r) {
                        return r.ok === false;
                    });
                    if (!allDone)
                        wr.notify(
                            'warning',
                            _('Some APs did not confirm in time. Check the result table below.'),
                        );
                    else if (bad.length)
                        wr.notify(
                            'danger',
                            _('Some APs failed to apply backhaul config') +
                                ': ' +
                                bad
                                    .map(function (r) {
                                        return r.name || r.ap;
                                    })
                                    .join(', '),
                        );
                    else wr.notify('success', _('Wireless backhaul applied to all APs'));
                });
            })
            .catch(function () {
                wr.notify('danger', _('Apply failed') + ': ' + _('request rejected'));
            })
            .then(function () {
                self.setBusy(false);
            });
    },
    // ---- Wireless backhaul ----
    renderBackhaulPanel: function (isCap) {
        var self = this;
        var src = (this.bh && this.bh.backhaul) || (this.st && this.st.backhaul) || {};
        var radios = (this.bh && this.bh.radios) || [];
        var bhEnable = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        bhEnable.checked = !!src.enabled;
        var bhSsid = E('input', {
            type: 'text',
            class: 'cbi-input-text',
            placeholder: 'wifiroam-bh',
            style: 'width:16em',
        });
        bhSsid.value = src.ssid || '';
        var bhKey = E('input', {
            type: 'text',
            class: 'cbi-input-text',
            placeholder: _('Leave empty to generate automatically'),
            style: 'width:16em',
        });
        bhKey.value = src.key || '';
        var bhDev = E(
            'select',
            { class: 'cbi-input-select' },
            [E('option', { value: '' }, _('Auto (prefer 5 GHz)'))].concat(
                radios
                    .filter(function (r) {
                        return !r.disabled;
                    })
                    .map(function (r) {
                        return E(
                            'option',
                            { value: r.name },
                            r.name + ' (' + wr.fmtBand(r.band) + ')',
                        );
                    }),
            ),
        );
        bhDev.value = src.device || '';
        var saveBtn = E(
            'button',
            { class: 'btn cbi-button-positive', click: L.bind(this.applyBackhaul, this) },
            _('Save & Apply'),
        );
        var panel = E('div', { class: 'cbi-section' }, [
            E('h3', {}, _('Wireless Backhaul')),
            E(
                'div',
                { class: 'wr-hint' },
                _(
                    'Creates a hidden WDS backhaul SSID on the main AP and a client uplink on sub APs. ' +
                        'Sub APs with a working cable automatically pause the wireless uplink to avoid L2 loops. ' +
                        'Saving restarts Wi-Fi briefly.',
                ),
            ),
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, [bhEnable, ' ', _('Enable wireless backhaul')]),
            ]),
            E('div', { class: 'wr-form-row' }, [E('label', {}, _('Backhaul SSID')), bhSsid]),
            E('div', { class: 'wr-form-row' }, [E('label', {}, _('Backhaul key')), bhKey]),
            E('div', { class: 'wr-form-row' }, [E('label', {}, _('Backhaul radio')), bhDev]),
            isCap ? E('div', {}, [saveBtn]) : '',
            E(
                'div',
                { id: 'wr-bh-apply' },
                this.renderBackhaulResults(this.st && this.st.last_backhaul),
            ),
        ]);
        this.els = this.els || {};
        this.els.bhEnable = bhEnable;
        this.els.bhSsid = bhSsid;
        this.els.bhKey = bhKey;
        this.els.bhDev = bhDev;
        this.els.bhSaveBtn = saveBtn;
        this.els.bhForm = panel;
        if (!isCap) wr.setFormDisabled(panel, true);
        return panel;
    },
    collectSsids: function () {
        var ssids = [];
        ((this.els && this.els.ssidChecks) || []).forEach(function (cb) {
            if (cb.checked) ssids.push(cb.getAttribute('data-ssid'));
        });
        return ssids;
    },
    setBusy: function (on) {
        this.busy = on;
        wr.setFormDisabled(this.els.form, on);
        wr.setBusy(this.els.saveBtn, on, on ? _('Applying...') : null);
        if (this.els.bhForm) wr.setFormDisabled(this.els.bhForm, on);
        if (this.els.bhSaveBtn) wr.setBusy(this.els.bhSaveBtn, on, on ? _('Applying...') : null);
    },
    waitResults: function (ver, timeout) {
        var self = this;
        return wr.pollUntil(
            function () {
                return wr.safeCall('status').then(function (st) {
                    if (!st || !st.last_apply || !st.last_apply.results) return false;
                    if (ver != null && st.last_apply.ver !== ver) return false;
                    self.st = st;
                    self.renderApply();
                    return st.last_apply.results.every(function (r) {
                        return r.ok !== null && r.ok !== undefined;
                    });
                });
            },
            1500,
            timeout || 30000,
        );
    },
    apply: function () {
        var self = this;
        if (this.busy) return;
        var e = this.els;
        var ssids = this.collectSsids();
        if (e.enableCb.checked && ssids.length === 0) {
            wr.notify('warning', _('Select at least one roaming SSID group.'));
            return;
        }
        this.setBusy(true);
        return wr
            .call('set_roam', {
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
            })
            .then(function (res) {
                if (!res || !res.ok) {
                    wr.notify(
                        'danger',
                        _('Apply failed') + ': ' + ((res && res.error) || _('request rejected')),
                    );
                    return;
                }
                self.st = self.st || {};
                self.st.last_apply = { ver: res.ver, results: res.results };
                self.renderApply();
                if (
                    res.results &&
                    res.results.some(function (r) {
                        return r.ok === null || r.ok === undefined;
                    })
                ) {
                    wr.notify(
                        'info',
                        _('Configuration sent, waiting for member APs to confirm...'),
                    );
                    return self.waitResults(res.ver).then(function (allDone) {
                        var bad = (self.st.last_apply.results || []).filter(function (r) {
                            return r.ok === false;
                        });
                        if (!allDone)
                            wr.notify(
                                'warning',
                                _(
                                    'Some APs did not confirm in time. Check the result table below.',
                                ),
                            );
                        else if (bad.length)
                            wr.notify(
                                'danger',
                                _('Some APs failed to apply roaming config') +
                                    ': ' +
                                    bad
                                        .map(function (r) {
                                            return r.name || r.ap;
                                        })
                                        .join(', '),
                            );
                        else wr.notify('success', _('Roaming configuration applied to all APs'));
                    });
                }
                wr.notify('success', _('Roaming configuration applied'));
            })
            .catch(function () {
                wr.notify('danger', _('Apply failed') + ': ' + _('request rejected'));
            })
            .then(function () {
                self.setBusy(false);
                self.refreshPre();
            });
    },
    pollStatus: function () {
        var self = this;
        if (this.busy) return Promise.resolve();
        return wr.safeCall('status').then(function (st) {
            if (!st) return;
            self.st = st;
            var sb = document.getElementById('wr-status');
            if (sb) dom.content(sb, wr.statusBar(st));
            self.renderApply();
        });
    },
    // ---- App recognition & statistics ----
    renderAppctlPanel: function (isCap) {
        var self = this;
        var ac = this.appctl || {};
        var usable = isCap && ac.ok && ac.enabled === true;
        var cb = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        cb.checked = ac.enhanced === true;
        var stCb = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        stCb.checked = ac.strict === true;
        var btn = E(
            'button',
            {
                class: 'btn cbi-button-positive',
                click: function () {
                    wr.setBusy(btn, true, _('Applying...'));
                    wr.call('set_appctl', {
                        enabled: ac.enabled,
                        enhanced: cb.checked,
                        strict: stCb.checked ? '1' : '0',
                    })
                        .then(function (res) {
                            wr.setBusy(btn, false);
                            if (!res || !res.ok) {
                                wr.notify(
                                    'danger',
                                    _('Failed') + ': ' + ((res && res.error) || 'unknown'),
                                );
                                return;
                            }
                            ac.enhanced = res.enhanced === true;
                            ac.strict = res.strict === true;
                            wr.notify(
                                'success',
                                cb.checked
                                    ? _(
                                          'Precise mode enabled. Hardware flow offload was suspended to keep counters complete.',
                                      )
                                    : _('Precise mode disabled. Reverted to the lenient mode.'),
                            );
                        })
                        .catch(function () {
                            wr.setBusy(btn, false);
                            wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                        });
                },
            },
            _('Save'),
        );
        var kids = [
            E('h3', {}, _('App Recognition & Statistics')),
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, [cb, ' ', _('Precise mode (recommended)')]),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _(
                        'Locks DNS egress to this router so apps cannot bypass recognition via built-in HTTPDNS/DoH/DoT; ' +
                            'counts usage time only when a window has real traffic (idle keep-alives ignored); ' +
                            'expires DNS-to-app mapping in 30 minutes to avoid stale CDN attribution; ' +
                            'suspends hardware flow offload while enabled so traffic counters stay complete (restored on disable).',
                    ),
                ),
            ]),
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, [stCb, ' ', _('Strict enforcement')]),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _(
                        'For devices with blocked apps: drop QUIC (UDP 443) to force TCP/TLS fallback, ' +
                            'block DNS queries that bypass this router, and block well-known DoH providers. ' +
                            'Improves blocking accuracy at the cost of stricter traffic handling.',
                    ),
                ),
            ]),
            isCap ? E('div', {}, [btn]) : '',
        ];
        if (!usable) {
            cb.disabled = true;
            stCb.disabled = true;
            btn.disabled = true;
            kids.splice(
                1,
                0,
                E(
                    'div',
                    { class: 'wr-hint' },
                    !isCap
                        ? _('App recognition can only be configured on the main AP.')
                        : _('Enable "App Usage & Access Control" on the Clients page first.'),
                ),
            );
        }
        return E('div', { class: 'cbi-section' }, kids);
    },
    // ---- Page entry point ----
    render: function (data) {
        this.cfg = data[0];
        this.st = data[1] || {};
        this.appctl = data[2] || null;
        var isCap = this.st.role === 'cap';
        window.setTimeout(L.bind(this.hydrate, this), 0);
        var back = E('div', { class: 'wr-toolbar' }, [
            E(
                'a',
                {
                    class: 'btn cbi-button cbi-button-action',
                    href: L.url('admin/wifiroam/settings'),
                },
                _('Back to Wireless Settings'),
            ),
            E(
                'div',
                { class: 'wr-hint' },
                _(
                    'Pre-flight checks and roaming settings are only needed for advanced multi-AP tuning.',
                ),
            ),
        ]);
        if (!this.cfg) {
            return E('div', {}, [
                wr.css(),
                E('h2', {}, _('Wireless Settings') + ' - ' + _('Advanced Settings')),
                E(
                    'div',
                    { class: 'alert-message danger' },
                    _(
                        'Cannot reach wifiroamd. Start the service on the Wireless Settings page, then reload this page.',
                    ),
                ),
            ]);
        }
        var roam = this.cfg.roam || {};
        var groups = this.cfg.groups || [];
        var self = this;
        var notice = null;
        if (!isCap)
            notice = E(
                'div',
                { class: 'alert-message warning' },
                _('Roaming can only be configured on the main AP (CAP). This device has role: ') +
                    (this.st.role || '-'),
            );
        var enableCb = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        enableCb.checked = !!roam.enabled;
        var ssidChecks = [];
        var ssidBoxes = groups.map(function (g) {
            var cb = E('input', {
                type: 'checkbox',
                class: 'cbi-input-checkbox',
                'data-ssid': g.ssid,
            });
            cb.checked = (roam.ssids || []).indexOf(g.ssid) >= 0;
            ssidChecks.push(cb);
            return E('div', { class: 'wr-ssid-group' }, [
                E('label', {}, [cb, ' ', E('b', {}, g.ssid)]),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('APs') +
                        ': ' +
                        g.ap_count +
                        ' | ' +
                        _('Bands') +
                        ': ' +
                        (g.bands || []).map(wr.fmtBand).join(', ') +
                        ' | ' +
                        _('Encryption') +
                        ': ' +
                        (g.encryptions || []).join(', ') +
                        (g.consistent ? '' : ' (' + _('inconsistent!') + ')'),
                ),
            ]);
        });
        if (!ssidBoxes.length)
            ssidBoxes = [
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('No AP interfaces found. Configure Wi-Fi SSIDs first.'),
                ),
            ];
        var ftSel = E('select', { class: 'cbi-input-select' }, [
            E('option', { value: 'simple' }, _('Simple (local key derivation, WPA2-PSK)')),
            E('option', { value: 'explicit' }, _('Expert (sync r0kh/r1kh, supports WPA3/EAP)')),
        ]);
        ftSel.value = roam.ft_mode || 'simple';
        var rFast = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        rFast.checked = roam.r_fast !== false;
        var ftDs = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        ftDs.checked = roam.ft_over_ds !== false;
        function syncFt() {
            var off = !rFast.checked;
            ftSel.disabled = off;
            ftDs.disabled = off;
        }
        rFast.addEventListener('change', syncFt);
        syncFt();
        var kN = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        kN.checked = roam.k_neighbor !== false;
        var kB = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        kB.checked = roam.k_beacon !== false;
        var vB = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        vB.checked = roam.v_bss_transition !== false;
        var rssiSel = E('select', { class: 'cbi-input-select' }, [
            E('option', { value: 'aggressive' }, _('Aggressive') + ' (-62 dBm)'),
            E('option', { value: 'balanced' }, _('Balanced') + ' (-70 dBm)'),
            E('option', { value: 'conservative' }, _('Conservative') + ' (-78 dBm)'),
            E('option', { value: 'custom' }, _('Custom')),
        ]);
        rssiSel.value =
            roam.rssi_profile === 'custom' || RSSI_PRESETS[roam.rssi_profile]
                ? roam.rssi_profile
                : 'balanced';
        var rssiVal = E('input', {
            type: 'number',
            min: '-95',
            max: '-30',
            step: '1',
            class: 'cbi-input-text',
            style: 'width:6em',
        });
        rssiVal.value =
            roam.rssi_threshold != null ? roam.rssi_threshold : RSSI_PRESETS[rssiSel.value];
        rssiVal.disabled = rssiSel.value !== 'custom';
        rssiSel.addEventListener('change', function () {
            var custom = rssiSel.value === 'custom';
            rssiVal.disabled = !custom;
            if (!custom) rssiVal.value = RSSI_PRESETS[rssiSel.value];
        });
        function cRow(label, widget, hint) {
            return E('div', { class: 'wr-form-row' }, [
                E('label', {}, label),
                widget,
                hint ? E('div', { class: 'wr-hint' }, hint) : '',
            ]);
        }
        function cbRow(label, widget, hint) {
            return E('div', { class: 'wr-form-row' }, [
                E('label', {}, [widget, ' ', label]),
                hint ? E('div', { class: 'wr-hint' }, hint) : '',
            ]);
        }
        var saveBtn = E(
            'button',
            { class: 'btn cbi-button-positive', click: L.bind(this.apply, this) },
            _('Save & Apply'),
        );
        var form = E('div', { class: 'cbi-section' }, [
            E('h3', {}, _('802.11k/v/r Seamless Roaming')),
            cbRow(
                _('Enable seamless roaming'),
                enableCb,
                _(
                    'Same SSID + same password must exist on all member APs. Wired backhaul between APs is recommended.',
                ),
            ),
            E(
                'div',
                { class: 'wr-form-row' },
                [E('label', {}, _('Roaming SSID groups'))].concat(ssidBoxes),
            ),
            cbRow(
                _('802.11r fast transition (R)'),
                rFast,
                _(
                    'When disabled, only 802.11k neighbor reports and 802.11v steering are used (no FT handover).',
                ),
            ),
            cRow(
                _('FT mode'),
                ftSel,
                _(
                    'Simple needs no key sync. Expert mode distributes FT keys to all member APs automatically.',
                ),
            ),
            cbRow(_('FT over DS (recommended with wired backhaul)'), ftDs),
            cbRow(_('802.11k neighbor report'), kN),
            cbRow(_('802.11k beacon report'), kB),
            cbRow(_('802.11v BSS transition management'), vB),
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, _('Roaming trigger threshold (RSSI)')),
                E('div', { class: 'wr-rssi-row' }, [rssiSel, ' ', rssiVal, ' dBm']),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _(
                        'When a client signal drops below this level, 802.11v BSS Transition asks it to move to a better AP.',
                    ),
                ),
            ]),
            isCap ? E('div', {}, [saveBtn]) : '',
        ]);
        this.els = {
            form: form,
            saveBtn: saveBtn,
            enableCb: enableCb,
            ssidChecks: ssidChecks,
            rFast: rFast,
            ftSel: ftSel,
            ftDs: ftDs,
            kN: kN,
            kB: kB,
            vB: vB,
            rssiSel: rssiSel,
            rssiVal: rssiVal,
        };
        if (!isCap) wr.setFormDisabled(form, true);
        poll.add(L.bind(this.pollStatus, this), 15);
        return E('div', { id: 'wr-adv' }, [
            wr.css(),
            E('h2', {}, _('Wireless Settings') + ' - ' + _('Advanced Settings')),
            back,
            E('div', { id: 'wr-status' }, wr.statusBar(this.st || {})),
            notice,
            E('div', { id: 'wr-pre' }, this.renderChecklist()),
            form,
            this.renderAppctlPanel(isCap),
            E('div', { id: 'wr-apply' }, this.renderApplyResults(this.st.last_apply)),
            E(
                'div',
                { id: 'wr-bh' },
                E('div', { class: 'wr-hint' }, _('Loading wireless backhaul settings...')),
            ),
        ]);
    },
    handleSaveApply: null,
    handleSave: null,
    handleReset: null,
});
