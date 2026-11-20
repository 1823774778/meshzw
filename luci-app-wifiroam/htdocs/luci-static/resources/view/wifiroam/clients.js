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
'require wifiroam.oui as oui';
'require wifiroam.devices as devices';
wr.useOui(oui.data);
wr.useDevices(devices);
var SVGNS = 'http://www.w3.org/2000/svg';
function svgNode(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    if (attrs)
        Object.keys(attrs).forEach(function (k) {
            n.setAttribute(k, attrs[k]);
        });
    return n;
}
return view.extend({
    data: null,
    filterAp: '',
    filterText: '',
    saving: {},
    savingCount: 0,
    editing: {},
    waking: {},
    load: function () {
        return wr.safeCall('device_history');
    },
    hasFocusInList: function () {
        var box = document.getElementById('wr-devices');
        var el = document.activeElement;
        return !!(box && el && box.contains(el) && /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
    },
    isEditing: function () {
        return Object.keys(this.editing).length > 0;
    },
    refresh: function () {
        return wr.safeCall('device_history').then(
            L.bind(function (d) {
                if (!d) return;
                this.data = d;
                if (this.savingCount > 0 || this.isEditing() || this.hasFocusInList()) return;
                this.renderCards();
            }, this),
        );
    },
    // ---- Rename / pin editing ----
    saveEdit: function (c, input, sel, btn, status) {
        var self = this;
        var key = 'edit:' + c.id;
        if (this.saving[key]) return;
        this.saving[key] = true;
        this.savingCount++;
        wr.setBusy(btn, true, _('Saving...'));
        dom.content(status, wr.inlineStatus('pending', _('Saving...')));
        var name = (input.value || '').trim();
        var pin = sel.value || '';
        var jobs = [];
        if (name !== (c.custom_name || ''))
            jobs.push(wr.call('set_alias', { mac: c.id, name: name }));
        if (pin !== (c.pin || '')) jobs.push(wr.call('set_pin', { mac: c.id, ap: pin }));
        return Promise.all(jobs)
            .then(
                function (res) {
                    var err = null;
                    (res || []).forEach(function (r) {
                        if (r && r.ok === false && !err) err = r.error;
                    });
                    if (err) throw { error: err };
                    c.custom_name = name || null;
                    c.name = name || c.hostname || c.mac;
                    c.pin = pin || null;
                    c.pin_name = c.pin ? self.apName(c.pin) : null;
                    delete self.editing[c.id];
                    dom.content(status, wr.inlineStatus('ok', '✓ ' + _('Saved')));
                },
                function (e) {
                    dom.content(
                        status,
                        wr.inlineStatus(
                            'fail',
                            '✗ ' + _('Failed') + (e && e.error ? ': ' + self.errText(e.error) : ''),
                        ),
                    );
                },
            )
            .then(function () {
                delete self.saving[key];
                self.savingCount--;
                wr.setBusy(btn, false);
                self.renderCards();
            });
    },
    errText: function (e) {
        return (
            {
                unknown_device: _('Device not found in history'),
                already_online: _('Device is already online'),
                send_failed: _('Failed to send magic packet'),
                invalid_mac: _('Invalid MAC address'),
                invalid_ap: _('Invalid AP'),
                unknown_ap: _('Unknown AP'),
                link_down: _('Link to main AP is down'),
            }[e] || e
        );
    },
    apName: function (id) {
        var aps = (this.data && this.data.aps) || [];
        for (var i = 0; i < aps.length; i++) if (aps[i].id === id) return aps[i].name;
        return id;
    },
    wake: function (c, btn) {
        var self = this;
        if (this.waking[c.id]) return;
        this.waking[c.id] = true;
        wr.setBusy(btn, true, _('Sending...'));
        return wr
            .call('wake', { mac: c.id })
            .then(
                function (res) {
                    if (res && res.ok)
                        wr.notify('success', _('Magic packet sent to %s').format(c.mac || c.id));
                    else
                        wr.notify(
                            'danger',
                            _('Wake failed') +
                                (res && res.error ? ': ' + self.errText(res.error) : ''),
                        );
                },
                function () {
                    wr.notify('danger', _('Wake failed') + ': ' + _('request rejected'));
                },
            )
            .then(function () {
                delete self.waking[c.id];
                wr.setBusy(btn, false);
            });
    },
    vendorInfo: function (c) {
        return wr.vendorOf(c.mac, (c.hostname || '') + ' ' + (c.name || ''));
    },
    avatar: function (c) {
        var v = this.vendorInfo(c);
        var color = (v && v.color) || '#90a4ae';
        var inner;
        if (v && v.logo) {
            inner = svgNode('svg', {
                viewBox: '0 0 24 24',
                width: '22',
                height: '22',
                fill: '#fff',
                'aria-hidden': 'true',
            });
            inner.appendChild(svgNode('path', { d: v.logo }));
        } else
            inner = E(
                'span',
                { class: 'wr-dcard-initial' },
                (v && v.initial) || (c.name || c.mac || '?').charAt(0).toUpperCase(),
            );
        return E('div', { class: 'wr-dcard-avatar', style: 'background:' + color }, inner);
    },
    row: function (label, value, extra) {
        return E('div', { class: 'wr-dcard-row' }, [
            E('span', { class: 'wr-dcard-key' }, label),
            E('span', { class: 'wr-dcard-val' }, [value, extra]),
        ]);
    },
    // ---- One client card ----
    card: function (c) {
        var self = this;
        var v = this.vendorInfo(c);
        var online = !!c.online;
        var editing = !!this.editing[c.id];
        var icon = svgNode('svg', {
            viewBox: '0 0 24 24',
            width: '16',
            height: '16',
            'aria-hidden': 'true',
            fill: 'none',
            stroke: 'currentColor',
            'stroke-width': '1.8',
            'stroke-linecap': 'round',
            'stroke-linejoin': 'round',
        });
        icon.appendChild(svgNode('path', { d: 'M12 5H5v14h14v-7' }));
        var pencil = svgNode('g', { transform: 'rotate(-45 12 12)' });
        pencil.appendChild(svgNode('path', { d: 'M5.5 10.3h10.5L20.5 12 16 13.7H5.5z' }));
        icon.appendChild(pencil);
        var editBtn = E(
            'button',
            {
                class: 'wr-dcard-edit-btn',
                title: _('Edit'),
                'aria-label': _('Edit'),
                click: function (ev) {
                    ev.stopPropagation();
                    self.editing[c.id] = true;
                    self.renderCards();
                },
            },
            [icon],
        );
        var editPanel = null;
        if (editing) {
            var input = E('input', {
                type: 'text',
                class: 'cbi-input-text wr-dcard-input',
                value: c.custom_name || '',
                placeholder: c.name || c.mac || '',
            });
            var pinSel = E('select', { class: 'cbi-input-select wr-dcard-pin-sel' }, [
                E('option', { value: '' }, _('Auto (no pin)')),
            ]);
            var aps = (this.data && this.data.aps) || [];
            var known = {};
            aps.forEach(function (a) {
                known[a.id] = true;
                pinSel.appendChild(E('option', { value: a.id }, a.name));
            });
            if (c.pin && !known[c.pin])
                pinSel.appendChild(E('option', { value: c.pin }, c.pin_name || c.pin));
            pinSel.value = c.pin || '';
            var status = E('span', { class: 'wr-hint' });
            var saveBtn = E(
                'button',
                {
                    class: 'btn cbi-button cbi-button-positive',
                    click: function () {
                        return self.saveEdit(c, input, pinSel, saveBtn, status);
                    },
                },
                _('Save'),
            );
            var cancelBtn = E(
                'button',
                {
                    class: 'btn cbi-button',
                    click: function () {
                        delete self.editing[c.id];
                        self.renderCards();
                    },
                },
                _('Cancel'),
            );
            input.addEventListener('keydown', function (ev) {
                if (ev.key === 'Enter') {
                    ev.preventDefault();
                    self.saveEdit(c, input, pinSel, saveBtn, status);
                }
            });
            editPanel = E('div', { class: 'wr-dcard-edit' }, [
                E('div', { class: 'wr-dcard-rename' }, [input]),
                E('div', { class: 'wr-dcard-pin' }, [
                    E('span', { class: 'wr-dcard-key' }, _('Pinned AP')),
                    pinSel,
                ]),
                E('div', { class: 'wr-dcard-edit-actions' }, [saveBtn, cancelBtn, status]),
            ]);
        }
        var rows = [
            this.row(_('IP Address'), c.ip || '-'),
            this.row(
                _('MAC Address'),
                c.mac || '-',
                c.grouped
                    ? E(
                          'div',
                          { class: 'wr-hint' },
                          _('%d recognized MACs').format((c.members || []).length),
                      )
                    : null,
            ),
            this.row(_('Vendor'), v ? v.name + (v.source === 'hostname' ? ' *' : '') : '-'),
        ];
        if (online) {
            rows.push(this.row(_('Connection'), wr.connText(c.conn)));
            rows.push(this.row(_('Attached AP'), c.ap_name || '-'));
            rows.push(
                this.row(
                    _('Signal'),
                    c.conn && c.conn.type === 'wifi' ? wr.rssiText(c.conn.rssi) : '-',
                ),
            );
            rows.push(
                this.row(
                    _('TX Rate (uplink)'),
                    c.conn && c.conn.type === 'wifi' ? wr.fmtRate(c.conn.tx_rate) : '-',
                ),
            );
        } else {
            rows.push(
                this.row(
                    _('Last connection'),
                    c.conn
                        ? wr.connText(c.conn)
                        : c.ap_name
                          ? _('Attached AP') + ': ' + c.ap_name
                          : '-',
                ),
            );
        }
        rows.push(
            this.row(
                _('Last online'),
                wr.fmtTime(c.last_online),
                c.last_online
                    ? E('span', { class: 'wr-hint' }, ' (' + wr.fmtAge(c.last_online) + ')')
                    : null,
            ),
        );
        rows.push(this.row(_('Last offline'), online ? '-' : wr.fmtTime(c.last_offline)));
        var actions = null;
        if (!online && c.can_wake) {
            var wbtn = E(
                'button',
                {
                    class: 'btn cbi-button cbi-button-action',
                    click: function () {
                        return self.wake(c, wbtn);
                    },
                },
                _('Wake on LAN'),
            );
            actions = E('div', { class: 'wr-dcard-actions' }, [
                wbtn,
                E('span', { class: 'wr-hint' }, _('Sends a magic packet to the last known MAC')),
            ]);
        }
        return E(
            'div',
            {
                class:
                    'wr-dcard' +
                    (online ? '' : ' wr-dcard-off') +
                    (editing ? ' wr-dcard-editing' : ''),
            },
            [
                E('div', { class: 'wr-dcard-head' }, [
                    this.avatar(c),
                    E('div', { class: 'wr-dcard-title' }, [
                        E(
                            'div',
                            { class: 'wr-dcard-name', title: c.mac || '' },
                            c.name || c.mac || '-',
                        ),
                        c.hostname && c.hostname !== c.name
                            ? E('div', { class: 'wr-hint' }, c.hostname)
                            : null,
                        !editing && c.pin
                            ? E(
                                  'div',
                                  { class: 'wr-dcard-pin-tag' },
                                  _('Pinned to %s').format(c.pin_name || c.pin),
                              )
                            : null,
                    ]),
                    E(
                        'span',
                        { class: 'wr-badge ' + (online ? 'wr-badge-on' : 'wr-badge-off') },
                        online ? _('Online') : _('Offline'),
                    ),
                    editing ? null : editBtn,
                ]),
                editPanel,
                E('div', { class: 'wr-dcard-rows' }, rows),
                actions,
            ],
        );
    },
    renderCards: function () {
        var box = document.getElementById('wr-devices');
        if (!box || !this.data) return;
        var all = this.data.devices || [];
        var fAp = this.filterAp,
            fText = (this.filterText || '').toLowerCase();
        var list = all.filter(function (c) {
            if (fAp && c.ap !== fAp) return false;
            if (fText) {
                var hay = (
                    (c.name || '') +
                    ' ' +
                    (c.ip || '') +
                    ' ' +
                    (c.mac || '') +
                    ' ' +
                    (c.members || []).join(' ') +
                    ' ' +
                    (c.hostname || '') +
                    ' ' +
                    (c.ap_name || '')
                ).toLowerCase();
                if (hay.indexOf(fText) < 0) return false;
            }
            return true;
        });
        var self = this;
        var cards = list.map(function (c) {
            return self.card(c);
        });
        var cnt = document.getElementById('wr-count');
        if (cnt) {
            var on = all.filter(function (c) {
                return c.online;
            }).length;
            dom.content(cnt, _('%d online / %d total').format(on, all.length));
        }
        dom.content(
            box,
            cards.length
                ? E('div', { class: 'wr-dcard-grid' }, cards)
                : E('div', { class: 'wr-empty' }, _('No clients found')),
        );
    },
    // ---- Page entry point ----
    render: function (data) {
        this.data = data;
        poll.add(L.bind(this.refresh, this), 15);
        var devices = (data && data.devices) || [];
        var self = this;
        var apSel = E(
            'select',
            {
                class: 'cbi-input-select',
                change: function (ev) {
                    self.filterAp = ev.target.value;
                    self.renderCards();
                },
            },
            [E('option', { value: '' }, _('All APs'))],
        );
        var seen = {};
        devices.forEach(function (c) {
            if (!c.ap || seen[c.ap]) return;
            seen[c.ap] = true;
            apSel.appendChild(E('option', { value: c.ap }, c.ap_name || c.ap));
        });
        var search = E('input', {
            type: 'text',
            class: 'cbi-input-text',
            placeholder: _('Search name / IP / MAC'),
            style: 'width:15em',
            input: function (ev) {
                self.filterText = ev.target.value;
                self.renderCards();
            },
        });
        var body = [wr.css(), E('h2', {}, _('Network Management') + ' - ' + _('Clients'))];
        if (!data)
            body.push(
                E(
                    'div',
                    { class: 'alert-message danger' },
                    _('Cannot reach wifiroamd. Make sure the service is running.'),
                ),
            );
        else
            body.push(
                E('div', { class: 'wr-toolbar' }, [
                    apSel,
                    search,
                    E('span', { id: 'wr-count', class: 'wr-hint' }),
                ]),
                E('div', { id: 'wr-devices' }),
            );
        var view = E('div', {}, body);
        window.setTimeout(function () {
            self.renderCards();
        }, 0);
        return view;
    },
    handleSaveApply: null,
    handleSave: null,
    handleReset: null,
});
