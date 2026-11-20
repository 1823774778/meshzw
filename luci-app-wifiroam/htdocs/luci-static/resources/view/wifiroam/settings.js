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
'require rpc';
'require wifiroam.common as wr';
var callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} },
});
var callRcList = rpc.declare({ object: 'rc', method: 'list', expect: { '': {} } });
var callRcInit = rpc.declare({ object: 'rc', method: 'init', params: ['name', 'action'] });
var REQUIRED_VERSION = 5;
return view.extend({
    pre: undefined,
    st: null,
    svc: null,
    rclist: null,
    busy: false,
    actionBusy: false,
    load: function () {
        return Promise.all([
            wr.safeCall('status'),
            wr.safeCall('offload_status'),
            wr.safeCall('get_wifi'),
            wr.safeCall('get_guest'),
            wr.safeCall('discover'),
            wr.safeCall('topology'),
        ]);
    },
    // ---- Wi-Fi (SSID / password) panel ----
    renderWifiPanel: function () {
        var self = this;
        var w = this.wifi || {};
        var isCap = w.role === 'cap' || this.isCap();
        var ifaces = w.ifaces || [];
        var bands = [];
        ifaces.forEach(function (it) {
            if (bands.indexOf(it.band) < 0) bands.push(it.band);
        });
        bands.sort();
        var uniCb = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        uniCb.checked = w.unified === true;
        var uniHint = E('div', { class: 'wr-hint' });
        var uniSsid = E('input', {
            type: 'text',
            class: 'cbi-input-text',
            style: 'width:16em',
            maxlength: '32',
            placeholder: _('Wi-Fi Name (SSID)'),
        });
        uniSsid.value = w.ssid || '';
        var uniKey = E('input', {
            type: 'password',
            class: 'cbi-input-text',
            style: 'width:16em',
            maxlength: '64',
            autocomplete: 'new-password',
            placeholder: _('Leave blank to keep current password'),
        });
        var unifiedBox = E('div', { class: 'wr-band-group' }, [
            E('h4', {}, _('Main Network')),
            E('div', { class: 'wr-form-row' }, [E('label', {}, _('Wi-Fi Name (SSID)')), uniSsid]),
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, _('Wi-Fi Password')),
                uniKey,
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('At least 8 characters. Leave blank to keep the current password.'),
                ),
            ]),
        ]);
        var bandInputs = [];
        var splitKids = [];
        bands.forEach(function (b) {
            var cur = null;
            ifaces.forEach(function (it) {
                if (!cur && it.band === b) cur = it;
            });
            var nameEl = E('input', {
                type: 'text',
                class: 'cbi-input-text',
                style: 'width:16em',
                maxlength: '32',
                placeholder: _('Wi-Fi Name (SSID)'),
            });
            nameEl.value = cur ? cur.ssid || '' : '';
            var keyEl = E('input', {
                type: 'password',
                class: 'cbi-input-text',
                style: 'width:16em',
                maxlength: '64',
                autocomplete: 'new-password',
                placeholder: _('Leave blank to keep current password'),
            });
            bandInputs.push({ band: b, nameEl: nameEl, keyEl: keyEl });
            splitKids.push(
                E('div', { class: 'wr-band-group' }, [
                    E('h4', {}, wr.fmtBand(b) + ' Wi-Fi'),
                    E('div', { class: 'wr-form-row' }, [
                        E('label', {}, _('Wi-Fi Name (SSID)')),
                        nameEl,
                    ]),
                    E('div', { class: 'wr-form-row' }, [
                        E('label', {}, _('Wi-Fi Password')),
                        keyEl,
                        E(
                            'div',
                            { class: 'wr-hint' },
                            _('At least 8 characters. Leave blank to keep the current password.'),
                        ),
                    ]),
                ]),
            );
        });
        if (!bands.length)
            splitKids.push(
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('No AP interfaces found. Configure Wi-Fi SSIDs first.'),
                ),
            );
        var splitBox = E('div', {}, splitKids);
        function syncMode() {
            var on = uniCb.checked;
            unifiedBox.style.display = on ? '' : 'none';
            splitBox.style.display = on ? 'none' : '';
            uniHint.textContent = on
                ? _(
                      '2.4G and 5G networks use the same name and password; clients automatically connect to the best band.',
                  )
                : _(
                      'Clients will not automatically switch to the best of the 2.4G and 5G networks.',
                  );
            if (on && !uniSsid.value && bandInputs.length)
                uniSsid.value = bandInputs[0].nameEl.value;
        }
        uniCb.addEventListener('change', syncMode);
        syncMode();
        var btn = E(
            'button',
            {
                class: 'btn cbi-button-positive',
                click: function () {
                    self.applyWifi(
                        { uniCb: uniCb, uniSsid: uniSsid, uniKey: uniKey, bandInputs: bandInputs },
                        btn,
                        resBox,
                    );
                },
            },
            _('Save Wi-Fi'),
        );
        var resBox = E(
            'div',
            { class: 'wr-hint' },
            w.last ? this.renderWifiResults(w.last.results) : '',
        );
        var kids = [
            E('h3', {}, _('Wi-Fi Settings')),
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, [uniCb, ' ', _('Multi-band unified')]),
            ]),
            uniHint,
            unifiedBox,
            splitBox,
            E('div', { class: 'wr-form-row' }, [
                isCap
                    ? btn
                    : E(
                          'div',
                          { class: 'wr-hint' },
                          _('Wi-Fi settings can only be changed on the main AP.'),
                      ),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _(
                        'Applies to all paired APs. Radios restart after saving, clients will reconnect.',
                    ),
                ),
            ]),
            resBox,
        ];
        var panel = E('div', { class: 'cbi-section' }, kids);
        if (!isCap || !bandInputs.length) {
            uniCb.disabled = true;
            uniSsid.disabled = true;
            uniKey.disabled = true;
            bandInputs.forEach(function (bi) {
                bi.nameEl.disabled = true;
                bi.keyEl.disabled = true;
            });
            btn.disabled = true;
            resBox.textContent = '';
        }
        return panel;
    },
    renderWifiResults: function (results) {
        if (!results || !results.length) return '';
        var s = '';
        results.forEach(function (r) {
            var mark = r.ok === true ? '\u2713' : r.ok === false ? '\u2717' : '\u2026';
            s += (s ? '  ' : '') + (r.name || r.ap || '') + ' ' + mark;
        });
        return _('Last result') + ': ' + s;
    },
    applyWifi: function (form, btn, resBox) {
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
            form.bandInputs.forEach(function (bi) {
                collect(bi.band, form.uniSsid, form.uniKey);
            });
        } else {
            form.bandInputs.forEach(function (bi) {
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
        wr.call('set_wifi', { unified: !!form.uniCb.checked, ifaces: ifaces })
            .then(function (res) {
                wr.setBusy(btn, false);
                if (!res || !res.ok) {
                    var why = res && res.error;
                    wr.notify(
                        'danger',
                        _('Failed') +
                            ': ' +
                            (why === 'not_cap'
                                ? _('Only the main AP can change Wi-Fi settings')
                                : why === 'ssid_invalid'
                                  ? _('SSID must be 1-32 characters')
                                  : why === 'key_invalid'
                                    ? _('Password must be at least 8 characters')
                                    : why || 'unknown'),
                    );
                    return;
                }
                form.uniKey.value = '';
                form.bandInputs.forEach(function (bi) {
                    bi.keyEl.value = '';
                });
                if (resBox) dom.content(resBox, self.renderWifiResults(res.results));
                self.refreshWifiResults(resBox);
                wr.notify(
                    'success',
                    _('Wi-Fi updated. Radios restart in a few seconds, clients will reconnect.'),
                );
            })
            .catch(function () {
                wr.setBusy(btn, false);
                wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
            });
    },
    refreshWifiResults: function (resBox) {
        var self = this;
        var tries = 0;
        function tick() {
            tries++;
            wr.safeCall('get_wifi').then(function (st) {
                if (!st || !st.last || !resBox) return;
                dom.content(resBox, self.renderWifiResults(st.last.results));
                var pending = (st.last.results || []).some(function (r) {
                    return r.ok === null || r.ok === undefined;
                });
                if (pending && tries < 6) window.setTimeout(tick, 2500);
            });
        }
        window.setTimeout(tick, 2500);
    },
    // ---- Guest network panel ----
    renderGuestPanel: function () {
        var self = this;
        var g = this.guest || {};
        var isCap = g.role === 'cap' || this.isCap();
        var hasKey = g.has_key === true;
        var cb = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        cb.checked = g.enabled === true;
        var ssidEl = E('input', {
            type: 'text',
            class: 'cbi-input-text',
            style: 'width:16em',
            maxlength: '32',
            placeholder: _('Wi-Fi Name (SSID)'),
        });
        ssidEl.value = g.ssid || '';
        var keyEl = E('input', {
            type: 'password',
            class: 'cbi-input-text',
            style: 'width:16em',
            maxlength: '64',
            autocomplete: 'new-password',
            placeholder: hasKey ? _('Leave blank to keep current password') : _('Wi-Fi Password'),
        });
        var openCb = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        openCb.checked = g.enabled === true && !hasKey;
        function syncOpen() {
            var on = openCb.checked;
            keyEl.disabled = on;
            keyEl.style.opacity = on ? '0.45' : '';
            if (on) {
                keyEl.value = '';
                keyEl.placeholder = _('No password (open network)');
            } else {
                keyEl.placeholder = hasKey
                    ? _('Leave blank to keep current password')
                    : _('Wi-Fi Password');
            }
        }
        openCb.addEventListener('change', syncOpen);
        syncOpen();
        var bwList = [0, 1, 2, 5, 10, 20, 50, 100];
        var bwVal = g.bandwidth || 0;
        if (bwVal > 0 && bwList.indexOf(bwVal) < 0) bwList.push(bwVal);
        var bwSel = E(
            'select',
            { class: 'cbi-input-select' },
            bwList.map(function (v) {
                return E('option', { value: '' + v }, v ? v + ' Mbps' : _('Unlimited'));
            }),
        );
        bwSel.value = '' + bwVal;
        var schedSel = E('select', { class: 'cbi-input-select' }, [
            E('option', { value: '0' }, _('All day')),
            E('option', { value: '1' }, _('Custom time window')),
        ]);
        schedSel.value = g.schedule ? '1' : '0';
        var startEl = E('input', { type: 'time', class: 'cbi-input-text' });
        startEl.value = g.start || '08:00';
        var endEl = E('input', { type: 'time', class: 'cbi-input-text' });
        endEl.value = g.end || '23:00';
        function syncSched() {
            var custom = schedSel.value === '1';
            startEl.disabled = !custom;
            endEl.disabled = !custom;
            startEl.style.opacity = endEl.style.opacity = custom ? '' : '0.45';
        }
        schedSel.addEventListener('change', syncSched);
        syncSched();
        var allowCb = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        allowCb.checked = g.allow_lan === true;
        var openHint =
            g.enabled && g.schedule && g.open === false
                ? E(
                      'div',
                      { class: 'wr-hint' },
                      _('Guest network is currently closed (outside the allowed time window).'),
                  )
                : null;
        var fields = E('div', {}, [
            E('div', { class: 'wr-guest-row' }, [
                E('label', {}, _('Wi-Fi Name (SSID)')),
                E('div', { class: 'wr-guest-ctrl' }, [ssidEl]),
            ]),
            E('div', { class: 'wr-guest-row' }, [
                E('label', {}, _('Wi-Fi Password')),
                E('div', { class: 'wr-guest-ctrl' }, [
                    keyEl,
                    E(
                        'label',
                        {
                            style: 'display:inline-flex;align-items:center;gap:0.35em;margin-left:0.7em;white-space:nowrap',
                        },
                        [openCb, _('Open (no password)')],
                    ),
                ]),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('At least 8 characters. Leave blank to keep the current password.'),
                ),
            ]),
            E('div', { class: 'wr-guest-row' }, [
                E('label', {}, _('Speed Limit')),
                E('div', { class: 'wr-guest-ctrl' }, [bwSel]),
                E('div', { class: 'wr-hint' }, _('Downstream limit for each guest device.')),
            ]),
            E('div', { class: 'wr-guest-row' }, [
                E('label', {}, _('Allowed Time')),
                E('div', { class: 'wr-guest-ctrl' }, [
                    schedSel,
                    startEl,
                    E('span', {}, ' \u2014 '),
                    endEl,
                ]),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('The guest SSID is turned off outside this window.'),
                ),
            ]),
            E('div', { class: 'wr-guest-row' }, [
                E('label', {}, _('Allow access to internal network')),
                E('div', { class: 'wr-guest-ctrl' }, [allowCb]),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('Off by default: guests can access the internet only.'),
                ),
            ]),
            openHint,
        ]);
        fields.style.display = cb.checked ? '' : 'none';
        cb.addEventListener('change', function () {
            fields.style.display = cb.checked ? '' : 'none';
        });
        var btn = E(
            'button',
            {
                class: 'btn cbi-button-positive',
                click: function () {
                    self.applyGuest(
                        {
                            cb: cb,
                            ssidEl: ssidEl,
                            keyEl: keyEl,
                            openCb: openCb,
                            bwSel: bwSel,
                            schedSel: schedSel,
                            startEl: startEl,
                            endEl: endEl,
                            allowCb: allowCb,
                        },
                        btn,
                        resBox,
                    );
                },
            },
            _('Save Guest Network'),
        );
        var resBox = E(
            'div',
            { class: 'wr-hint' },
            g.last ? this.renderWifiResults(g.last.results) : '',
        );
        var panel = E('div', { class: 'cbi-section' }, [
            E('h3', {}, _('Guest Network')),
            E('div', { class: 'wr-guest-row wr-guest-head' }, [
                E('label', {}, _('Guest Network')),
                E('div', { class: 'wr-guest-ctrl' }, [cb]),
            ]),
            fields,
            E('div', { class: 'wr-form-row' }, [
                isCap
                    ? btn
                    : E(
                          'div',
                          { class: 'wr-hint' },
                          _('Guest network can only be changed on the main AP.'),
                      ),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _('Applies to all paired APs. The guest SSID restarts after saving.'),
                ),
            ]),
            resBox,
        ]);
        if (!isCap) {
            wr.setFormDisabled(panel, true);
            resBox.textContent = '';
        }
        return panel;
    },
    applyGuest: function (form, btn, resBox) {
        var self = this;
        var g = this.guest || {};
        var on = !!form.cb.checked;
        var ssid = (form.ssidEl.value || '').trim();
        var openNet = !!form.openCb.checked;
        var key = openNet ? '' : form.keyEl.value || '';
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
                    wr.notify(
                        'warning',
                        _('Please set a Wi-Fi password, or tick "Open (no password)"'),
                    );
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
            schedule: form.schedSel.value === '1',
            start: form.startEl.value || '08:00',
            end: form.endEl.value || '23:00',
            allow_lan: !!form.allowCb.checked,
        })
            .then(function (res) {
                wr.setBusy(btn, false);
                if (!res || !res.ok) {
                    var why = res && res.error;
                    wr.notify(
                        'danger',
                        _('Failed') +
                            ': ' +
                            (why === 'not_cap'
                                ? _('Only the main AP can change guest network settings')
                                : why === 'ssid_invalid'
                                  ? _('SSID must be 1-32 characters')
                                  : why === 'key_invalid'
                                    ? _('Password must be at least 8 characters')
                                    : why === 'time_invalid'
                                      ? _('Invalid time window')
                                      : why || 'unknown'),
                    );
                    return;
                }
                self.guest = self.guest || {};
                if (openNet) self.guest.has_key = false;
                else if (key !== '') self.guest.has_key = true;
                self.guest.enabled = on;
                self.guest.ssid = ssid;
                self.guest.bandwidth = parseInt(form.bwSel.value, 10) || 0;
                self.guest.schedule = form.schedSel.value === '1';
                self.guest.start = form.startEl.value || '08:00';
                self.guest.end = form.endEl.value || '23:00';
                self.guest.allow_lan = !!form.allowCb.checked;
                form.keyEl.value = '';
                if (resBox) dom.content(resBox, self.renderWifiResults(res.results));
                self.refreshGuestResults(resBox);
                wr.notify(
                    'success',
                    _('Guest network updated. The guest SSID restarts in a few seconds.'),
                );
            })
            .catch(function () {
                wr.setBusy(btn, false);
                wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
            });
    },
    refreshGuestResults: function (resBox) {
        var self = this;
        var tries = 0;
        function tick() {
            tries++;
            wr.safeCall('get_guest').then(function (st) {
                if (!st || !st.last || !resBox) return;
                dom.content(resBox, self.renderWifiResults(st.last.results));
                var pending = (st.last.results || []).some(function (r) {
                    return r.ok === null || r.ok === undefined;
                });
                if (pending && tries < 6) window.setTimeout(tick, 2500);
            });
        }
        window.setTimeout(tick, 2500);
    },
    // ---- Hardware flow-offload panel ----
    renderOffload: function () {
        var off = this.offload || {};
        var now = E(
            'span',
            { class: 'wr-hint' },
            off.enabled ? _('Currently on') : _('Currently off'),
        );
        var cb = E('input', {
            type: 'checkbox',
            class: 'wr-switch-input',
            change: function (ev) {
                var want = ev.target.checked;
                ev.target.disabled = true;
                wr.call('set_offload', { enabled: want })
                    .then(function (res) {
                        if (!res || !res.ok) {
                            ev.target.checked = !want;
                            wr.notify(
                                'danger',
                                _('Failed') + ': ' + ((res && res.error) || 'unknown'),
                            );
                            return;
                        }
                        wr.notify(
                            'success',
                            want
                                ? _('Hardware acceleration enabled')
                                : _('Hardware acceleration disabled'),
                        );
                        return wr.safeCall('offload_status').then(function (st) {
                            cb.checked = st ? !!st.enabled : want;
                            dom.content(
                                now,
                                st && st.enabled ? _('Currently on') : _('Currently off'),
                            );
                        });
                    })
                    .catch(function () {
                        ev.target.checked = !want;
                        wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
                    })
                    .then(function () {
                        ev.target.disabled = false;
                    });
            },
        });
        cb.checked = !!off.enabled;
        return E('div', { class: 'cbi-section' }, [
            E('h3', {}, _('Hardware Acceleration (flow offloading)')),
            E('div', { class: 'wr-form-row' }, [
                E('label', {}, [cb, ' ', _('Enable flow offloading')]),
                E(
                    'div',
                    { class: 'wr-hint' },
                    _(
                        'When enabled, established connections bypass the firewall rules used for app detection, so app usage statistics and per-app access control may be incomplete. Turn it off if app detection matters more than forwarding throughput.',
                    ),
                ),
                E('div', { class: 'wr-hint' }, [_('Applies to all paired APs.'), ' ', now]),
            ]),
        ]);
    },
    // ---- Service (procd / rc) state ----
    hydrate: function () {
        var self = this;
        return Promise.all([
            callServiceList('wifiroam').catch(function () {
                return null;
            }),
            callRcList().catch(function () {
                return null;
            }),
        ])
            .then(function (res) {
                self.svc = res[0];
                self.rclist = res[1];
                var svc = document.getElementById('wr-svc');
                if (svc) dom.content(svc, self.renderServicePanel());
            })
            .catch(function () {});
    },
    isCap: function () {
        return !!(this.st && this.st.role === 'cap');
    },
    versionStale: function () {
        var st = this.st;
        return !!(st && st.role && st.version !== REQUIRED_VERSION);
    },
    svcRunning: function () {
        var s = this.svc && this.svc.wifiroam;
        var inst = (s && s.instances) || {};
        for (var k in inst) if (inst[k] && inst[k].running) return true;
        return false;
    },
    svcEnabled: function () {
        var r = this.rclist && this.rclist.wifiroam;
        return !!(r && r.enabled);
    },
    refreshService: function () {
        var self = this;
        return Promise.all([
            callServiceList('wifiroam').catch(function () {
                return null;
            }),
            callRcList().catch(function () {
                return null;
            }),
        ]).then(function (res) {
            self.svc = res[0];
            self.rclist = res[1];
            var box = document.getElementById('wr-svc');
            if (box) dom.content(box, self.renderServicePanel());
        });
    },
    serviceAction: function (action) {
        var self = this;
        var btn = this.svcBtns ? this.svcBtns[action] : null;
        wr.setBusy(btn, true, _('Working...'));
        return callRcInit('wifiroam', action)
            .then(function (rc) {
                if (rc) throw new Error(_('Command failed'));
                if (action !== 'restart') return null;
                return self.repairIfStale();
            })
            .then(function (repaired) {
                if (repaired === true)
                    wr.notify(
                        'warning',
                        _('The running version was outdated and has been repaired automatically.'),
                    );
                else if (repaired === false)
                    wr.notify(
                        'danger',
                        _(
                            'Version mismatch persists after repair. Please update the plugin packages.',
                        ),
                    );
                else wr.notify('success', _('Service action applied') + ': ' + action);
                return new Promise(function (resolve) {
                    window.setTimeout(resolve, 1500);
                }).then(function () {
                    window.location.reload();
                });
            })
            .catch(function (e) {
                wr.notify(
                    'danger',
                    _('Service action failed') + ': ' + (e && e.message ? e.message : action),
                );
                wr.setBusy(btn, false);
                return self.refreshService();
            });
    },
    repairIfStale: function () {
        function ready() {
            return wr.safeCall('status').then(function (st) {
                return !!(st && st.version === REQUIRED_VERSION);
            });
        }
        return wr.pollUntil(ready, 1000, 12000).then(function (ok) {
            if (ok) return null;
            return callRcInit('wifiroam', 'stop')
                .catch(function () {
                    return null;
                })
                .then(function () {
                    return new Promise(function (resolve) {
                        window.setTimeout(resolve, 800);
                    });
                })
                .then(function () {
                    return callRcInit('wifiroam', 'start').catch(function () {
                        return null;
                    });
                })
                .then(function () {
                    return wr.pollUntil(ready, 1000, 15000);
                })
                .then(function (ok2) {
                    return !!ok2;
                });
        });
    },
    toggleAutostart: function (on) {
        var self = this;
        return callRcInit('wifiroam', on ? 'enable' : 'disable')
            .then(function (rc) {
                if (rc) throw new Error(_('Command failed'));
                wr.notify(
                    'info',
                    on
                        ? _('Service will start automatically on boot')
                        : _('Service autostart disabled'),
                );
                return self.refreshService();
            })
            .catch(function () {
                wr.notify('danger', _('Service action failed'));
                return self.refreshService();
            });
    },
    renderServicePanel: function () {
        var self = this;
        var running = this.svcRunning();
        var enabled = this.svcEnabled();
        var btns = {};
        function actBtn(action, label, cls) {
            var attrs = {
                class: 'btn ' + cls,
                click: function () {
                    self.serviceAction(action);
                },
            };
            if ((action === 'start' && running) || (action === 'stop' && !running))
                attrs.disabled = 'disabled';
            var b = E('button', attrs, label);
            btns[action] = b;
            return b;
        }
        this.svcBtns = btns;
        var auto = E('input', { type: 'checkbox', class: 'wr-switch-input' });
        auto.checked = enabled;
        auto.addEventListener('change', function () {
            self.toggleAutostart(auto.checked).then(function () {
                if (!self.rclist) return;
                auto.checked = self.svcEnabled();
            });
        });
        return E('div', { class: 'cbi-section' }, [
            E('h3', {}, _('Plugin Service')),
            E('div', { class: 'wr-svc-row' }, [
                E(
                    'span',
                    { class: 'wr-badge ' + (running ? 'wr-badge-on' : 'wr-badge-off') },
                    running ? _('Running') : _('Stopped'),
                ),
                E(
                    'span',
                    { class: 'wr-hint' },
                    _(
                        'wifiroamd is the daemon that discovers APs and applies roaming configuration.',
                    ),
                ),
            ]),
            E('div', { class: 'wr-toolbar' }, [
                actBtn('start', _('Start'), 'cbi-button-positive'),
                actBtn('stop', _('Stop'), 'cbi-button-negative'),
                actBtn('restart', _('Restart'), 'cbi-button-action'),
                E('label', { class: 'wr-svc-auto' }, [auto, ' ', _('Start automatically on boot')]),
            ]),
        ]);
    },
    normMac: function (m) {
        return (m || '').toLowerCase().replace(/[^0-9a-f]/g, '');
    },
    isMember: function (mac) {
        var nm = this.normMac(mac);
        var nodes = (this.topo && this.topo.nodes) || [];
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].type !== 'ap') continue;
            if (this.normMac(nodes[i].mac || nodes[i].id) === nm) return true;
        }
        return false;
    },
    // ---- Pairing / member-AP body ----
    fetchData: function (render) {
        var self = this;
        return Promise.all([
            wr.safeCall('status'),
            wr.safeCall('discover'),
            wr.safeCall('topology'),
        ]).then(function (res) {
            if (res[0]) self.st = res[0];
            if (res[1]) self.disc = res[1];
            if (res[2]) self.topo = res[2];
            var sb = document.getElementById('wr-status');
            if (sb && self.st) dom.content(sb, wr.statusBar(self.st));
            if (render !== false && !self.actionBusy) self.renderBody();
            return res;
        });
    },
    refresh: function () {
        return this.fetchData(true);
    },
    renderBody: function () {
        var box = document.getElementById('wr-pair-body');
        if (box) dom.content(box, this.buildBody());
    },
    errText: function (code) {
        switch (code) {
            case 'not_cap':
                return _('this device is not the main AP');
            case 'not_found':
                return _('device not found (it may have gone offline)');
            case 'no_ip':
                return _('device has no IP address yet');
            case 'socket':
                return _('cannot open control connection to the device');
            case 'sap_via_pairing':
                return _('sub APs must be added by pairing from the main AP');
            case 'invalid_mac':
                return _('invalid MAC address');
            case 'timeout':
                return _('timed out');
        }
        return code || _('request rejected');
    },
    pairDevice: function (d, btn) {
        var self = this;
        if (this.actionBusy) return;
        this.actionBusy = true;
        wr.setBusy(btn, true, _('Pairing...'));
        return wr
            .call('pair', { mac: d.mac })
            .then(function (res) {
                if (!res || !res.ok) {
                    wr.notify('danger', _('Pair failed') + ': ' + self.errText(res && res.error));
                    return;
                }
                wr.notify(
                    'info',
                    _('Pairing request sent to') +
                        ' ' +
                        (d.ip || d.mac) +
                        ' — ' +
                        _('waiting for the device to join...'),
                );
                return wr
                    .pollUntil(
                        function () {
                            return self.fetchData(false).then(function () {
                                return self.isMember(d.mac);
                            });
                        },
                        2000,
                        45000,
                    )
                    .then(function (joined) {
                        if (joined) {
                            wr.notify('success', _('Device paired successfully'));
                        } else {
                            wr.notify(
                                'warning',
                                _(
                                    'Device did not join in time. Make sure it is powered on and connected to the same LAN.',
                                ),
                            );
                        }
                    });
            })
            .catch(function () {
                wr.notify('danger', _('Pair failed') + ': ' + _('request rejected'));
            })
            .then(function () {
                self.actionBusy = false;
                return self.refresh();
            });
    },
    unpairDevice: function (a, btn) {
        var self = this;
        if (this.actionBusy) return;
        if (!confirm(_('Remove this AP from the network?'))) return;
        this.actionBusy = true;
        wr.setBusy(btn, true, _('Removing...'));
        return wr
            .call('unpair', { mac: a.mac })
            .then(function (res) {
                if (res && res.ok === false) {
                    wr.notify('danger', _('Remove failed') + ': ' + self.errText(res.error));
                    return;
                }
                wr.notify('info', _('AP removed'));
                return wr.pollUntil(
                    function () {
                        return self.fetchData(false).then(function () {
                            return !self.isMember(a.mac);
                        });
                    },
                    1500,
                    15000,
                );
            })
            .catch(function () {
                wr.notify('danger', _('Remove failed') + ': ' + _('request rejected'));
            })
            .then(function () {
                self.actionBusy = false;
                return self.refresh();
            });
    },
    setRole: function (role, btn) {
        var self = this;
        if (this.actionBusy) return;
        if (role === 'unconfigured' && !confirm(_('Reset this device to unconfigured state?')))
            return;
        this.actionBusy = true;
        wr.setBusy(btn, true, _('Applying...'));
        return wr
            .call('set_role', { role: role })
            .then(function (res) {
                if (res && res.ok === false) {
                    wr.notify('danger', _('Failed') + ': ' + self.errText(res.error));
                    return;
                }
                wr.notify(
                    'success',
                    role === 'cap'
                        ? _('This device is now the main AP (CAP)')
                        : _('This device is now unconfigured'),
                );
            })
            .catch(function () {
                wr.notify('danger', _('Failed') + ': ' + _('request rejected'));
            })
            .then(function () {
                self.actionBusy = false;
                return self.refresh();
            });
    },
    buildBody: function () {
        var self = this;
        var st = this.st || {};
        var isCap = st.role === 'cap';
        var frag = E('div', {});
        var roleRows = [
            E('tr', {}, [E('td', {}, _('Role')), E('td', {}, wr.roleBadge(st.role))]),
            E('tr', {}, [E('td', {}, _('Device Name')), E('td', {}, st.name || '-')]),
            E('tr', {}, [E('td', {}, _('Model')), E('td', {}, st.model || '-')]),
            E('tr', {}, [E('td', {}, _('Firmware')), E('td', {}, st.firmware || '-')]),
        ];
        if (st.role === 'sap')
            roleRows.push(E('tr', {}, [E('td', {}, _('Main AP')), E('td', {}, st.cap_ip || '-')]));
        var roleCard = E('div', { class: 'cbi-section' }, [
            E('h3', {}, _('This Device')),
            E('table', { class: 'table wr-detail-table' }, roleRows),
        ]);
        if (st.role === 'unconfigured') {
            var setCapBtn = E(
                'button',
                {
                    class: 'btn cbi-button-positive',
                    click: function () {
                        return self.setRole('cap', setCapBtn);
                    },
                },
                _('Set as Main AP (CAP)'),
            );
            roleCard.appendChild(
                E('div', { style: 'margin-top:0.8em' }, [
                    setCapBtn,
                    E(
                        'div',
                        { class: 'wr-hint' },
                        _('Or keep it unconfigured and pair it from an existing main AP.'),
                    ),
                ]),
            );
        } else if (isCap) {
            var resetBtn = E(
                'button',
                {
                    class: 'btn cbi-button-negative',
                    click: function () {
                        return self.setRole('unconfigured', resetBtn);
                    },
                },
                _('Reset Role'),
            );
            roleCard.appendChild(
                E('div', { style: 'margin-top:0.8em' }, [
                    resetBtn,
                    E(
                        'div',
                        { class: 'wr-hint' },
                        _('Resetting clears the network token; member APs must be paired again.'),
                    ),
                ]),
            );
        }
        frag.appendChild(roleCard);
        if (!isCap) {
            frag.appendChild(
                E(
                    'div',
                    { class: 'alert-message info' },
                    _('Pairing and member management are done on the main AP (CAP).'),
                ),
            );
            return frag;
        }
        var devices = (this.disc && this.disc.devices) || [];
        var discRows = devices.map(function (d) {
            var pairBtn = E(
                'button',
                {
                    class: 'btn cbi-button-positive',
                    click: function () {
                        return self.pairDevice(d, pairBtn);
                    },
                },
                _('Pair'),
            );
            return E('tr', {}, [
                E('td', {}, d.name || '-'),
                E('td', {}, d.model || '-'),
                E('td', { style: 'font-family:monospace' }, d.mac || d.id || '-'),
                E('td', {}, d.ip || '-'),
                E('td', {}, wr.fmtAge(d.last_seen)),
                E('td', {}, pairBtn),
            ]);
        });
        var discTable = E(
            'table',
            { class: 'table cbi-section-table' },
            [
                E('tr', { class: 'tr table-titles' }, [
                    E('th', {}, _('Name')),
                    E('th', {}, _('Model')),
                    E('th', {}, _('MAC')),
                    E('th', {}, _('IP')),
                    E('th', {}, _('Last Seen')),
                    E('th', {}, ''),
                ]),
            ].concat(
                discRows.length
                    ? discRows
                    : [
                          E('tr', { class: 'tr placeholder' }, [
                              E(
                                  'td',
                                  { colspan: 6 },
                                  _(
                                      'No new devices found. Factory-reset / flash a device with wifiroam and connect it to the LAN.',
                                  ),
                              ),
                          ]),
                      ],
            ),
        );
        frag.appendChild(
            E('div', { class: 'cbi-section' }, [
                E('h3', {}, _('Discovered New Devices')),
                discTable,
            ]),
        );
        var topo = this.topo || {};
        var nodes = topo.nodes || [];
        var members = nodes.filter(function (n) {
            return n.type === 'ap' && n.id !== topo.self;
        });
        var memberRows = members.map(function (a) {
            var rmBtn = E(
                'button',
                {
                    class: 'btn cbi-button-negative',
                    click: function () {
                        return self.unpairDevice(a, rmBtn);
                    },
                },
                _('Remove'),
            );
            return E('tr', {}, [
                E('td', {}, a.name || '-'),
                E('td', {}, a.ip || '-'),
                E('td', {}, a.model || '-'),
                E(
                    'td',
                    {},
                    a.uplink ? (a.uplink.type === 'wired' ? _('Wired') : _('Wireless')) : '-',
                ),
                E('td', {}, '' + (a.clients || []).length),
                E('td', {}, rmBtn),
            ]);
        });
        var memberTable = E(
            'table',
            { class: 'table cbi-section-table' },
            [
                E('tr', { class: 'tr table-titles' }, [
                    E('th', {}, _('Name')),
                    E('th', {}, _('IP')),
                    E('th', {}, _('Model')),
                    E('th', {}, _('Backhaul')),
                    E('th', {}, _('Clients')),
                    E('th', {}, ''),
                ]),
            ].concat(
                memberRows.length
                    ? memberRows
                    : [
                          E('tr', { class: 'tr placeholder' }, [
                              E('td', { colspan: 6 }, _('No member APs yet')),
                          ]),
                      ],
            ),
        );
        frag.appendChild(
            E('div', { class: 'cbi-section' }, [E('h3', {}, _('Member APs')), memberTable]),
        );
        return frag;
    },
    // ---- Page entry point ----
    render: function (data) {
        this.st = data[0] || {};
        this.offload = data[1] || {};
        this.wifi = data[2] || {};
        this.guest = data[3] || {};
        this.disc = data[4];
        this.topo = data[5];
        window.setTimeout(L.bind(this.hydrate, this), 0);
        poll.add(L.bind(this.refresh, this), 10);
        if (!this.st || !this.st.role) {
            return E('div', {}, [
                wr.css(),
                E('h2', {}, _('Network Management') + ' - ' + _('Wireless Settings')),
                E(
                    'div',
                    { id: 'wr-svc' },
                    E('div', { class: 'wr-hint' }, _('Loading service status...')),
                ),
                E(
                    'div',
                    { class: 'alert-message danger' },
                    _('Cannot reach wifiroamd. Start the service above, then reload this page.'),
                ),
            ]);
        }
        var verWarn = null;
        if (this.versionStale())
            verWarn = E(
                'div',
                { class: 'alert-message warning' },
                _(
                    'The running wifiroamd version does not match this LuCI app. Click Restart to repair automatically.',
                ),
            );
        var advLink = E('div', { class: 'wr-toolbar' }, [
            E(
                'a',
                {
                    class: 'btn cbi-button cbi-button-action',
                    href: L.url('admin/wifiroam/advanced'),
                },
                _('Advanced Settings'),
            ),
            E(
                'div',
                { class: 'wr-hint' },
                _(
                    'Pre-flight checks, member AP details, 802.11k/v/r seamless roaming and wireless backhaul are in Advanced Settings.',
                ),
            ),
        ]);
        return E('div', { id: 'wr-set' }, [
            wr.css(),
            E('h2', {}, _('Network Management') + ' - ' + _('Wireless Settings')),
            advLink,
            E('div', { id: 'wr-status' }, wr.statusBar(this.st || {})),
            verWarn,
            E(
                'div',
                { id: 'wr-svc' },
                E('div', { class: 'wr-hint' }, _('Loading service status...')),
            ),
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
