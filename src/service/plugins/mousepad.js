// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import Gst from 'gi://Gst';
import GstApp from 'gi://GstApp';

import * as Components from '../components/index.js';
import {InputDialog} from '../ui/mousepad.js';
import Plugin from '../plugin.js';

Gst.init(null);

const SCREENSHARE_FPS = 30;
const SCREENSHARE_BITRATE_KBPS = 2500;
const SCREENSHARE_MAX_OUT_DIM = 720;
const SCREENSHARE_ZOOM_OUT = 1.0; // 1.0 = strict 1:1 physical mm; increase (e.g. 1.25) to zoom out
const STREAM_PORT_MIN = 1720;
const STREAM_PORT_MAX = 1764;
const FALLBACK_MM_PER_PX = 25.4 / 96.0;

const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop';
const SCREENCAST_IFACE = 'org.freedesktop.portal.ScreenCast';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const SESSION_IFACE = 'org.freedesktop.portal.Session';

const SHELL_BUS_NAME = 'org.gnome.Shell';
const SHELL_POINTER_PATH = '/org/gnome/Shell/Extensions/GSConnect/Pointer';
const SHELL_POINTER_IFACE = 'org.gnome.Shell.Extensions.GSConnect.Pointer';

export const Metadata = {
    label: _('Mousepad'),
    description: _('Enables the paired device to act as a remote mouse and keyboard'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad',
    incomingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate',
        'kdeconnect.mousepad.screenshare',
    ],
    outgoingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate',
        'kdeconnect.mousepad.screenshare',
    ],
    actions: {
        keyboard: {
            label: _('Remote Input'),
            icon_name: 'input-keyboard-symbolic',
            parameter_type: null,
            incoming: [
                'kdeconnect.mousepad.echo',
                'kdeconnect.mousepad.keyboardstate',
            ],
            outgoing: ['kdeconnect.mousepad.request'],
        },
        screenShare: {
            label: _('Screen Sharing'),
            icon_name: 'preferences-desktop-remote-desktop-symbolic',
            parameter_type: null,
            incoming: [],
            outgoing: [],
        },
    },
};

const KeyMap = new Map([
    [1, Gdk.KEY_BackSpace], [2, Gdk.KEY_Tab], [3, Gdk.KEY_Linefeed],
    [4, Gdk.KEY_Left], [5, Gdk.KEY_Up], [6, Gdk.KEY_Right], [7, Gdk.KEY_Down],
    [8, Gdk.KEY_Page_Up], [9, Gdk.KEY_Page_Down], [10, Gdk.KEY_Home],
    [11, Gdk.KEY_End], [12, Gdk.KEY_Return], [13, Gdk.KEY_Delete],
    [14, Gdk.KEY_Escape], [15, Gdk.KEY_Sys_Req], [16, Gdk.KEY_Scroll_Lock],
    [17, 0], [18, 0], [19, 0], [20, 0],
    [21, Gdk.KEY_F1], [22, Gdk.KEY_F2], [23, Gdk.KEY_F3], [24, Gdk.KEY_F4],
    [25, Gdk.KEY_F5], [26, Gdk.KEY_F6], [27, Gdk.KEY_F7], [28, Gdk.KEY_F8],
    [29, Gdk.KEY_F9], [30, Gdk.KEY_F10], [31, Gdk.KEY_F11], [32, Gdk.KEY_F12],
]);

const KeyMapCodes = new Map([
    [1, 14], [2, 15], [3, 101], [4, 105], [5, 103], [6, 106], [7, 108],
    [8, 104], [9, 109], [10, 102], [11, 107], [12, 28], [13, 111], [14, 1],
    [15, 99], [16, 70], [17, 0], [18, 0], [19, 0], [20, 0],
    [21, 59], [22, 60], [23, 61], [24, 62], [25, 63], [26, 64],
    [27, 65], [28, 66], [29, 67], [30, 68], [31, 87], [32, 88],
]);

const MousepadPlugin = GObject.registerClass({
    GTypeName: 'GSConnectMousepadPlugin',
    Properties: {
        'state': GObject.ParamSpec.boolean(
            'state', 'State', 'Remote keyboard state',
            GObject.ParamFlags.READABLE, false
        ),
        'screenshare': GObject.ParamSpec.boolean(
            'screenshare', 'Screenshare', 'Screen sharing mode',
            GObject.ParamFlags.READABLE, false
        ),
    },
}, class MousepadPlugin extends Plugin {
    _init(device) {
        super._init(device, 'mousepad');

        if (!globalThis.HAVE_GNOME)
            this._input = Components.acquire('ydotool');
        else
            this._input = Components.acquire('input');

        this._shareControlChangedId = this.settings.connect(
            'changed::share-control',
            this._sendState.bind(this)
        );

        this._shareScreenChangedId = this.settings.connect(
            'changed::share-screen',
            () => {
                if (!this.settings.get_boolean('share-screen') && this._screenshare)
                    this._stopScreenSharing();
            }
        );

        this._screenshare = false;
        this._startingScreenShare = false;
        this._screenShareTimerId = 0;
        this._disconnectTimerId = 0;
        this._pipeline = null;
        this._appsink = null;
        this._videobox = null;
        this._boxSinkPad = null;
        this._portalSessionPath = null;

        this._tcpServer = null;
        this._streamConnection = null;
        this._streamOut = null;
        this._writingFrame = false;

        this._pollingPointer = false;
        this._shellPointerAvailable = true;
        this._cropDirty = false;
        this._boxLeft = null;
        this._boxTop = null;
        this._fracX = 0;
        this._fracY = 0;

        this._streamPos = [0, 0];
        this._streamLogicalSize = [1920, 1080];
        this._streamPixelSize = [0, 0];
        this._monitorMm = [508, 285];
        this._cursorLogical = [960, 540];
        this._phoneViewMm = [70, 140];
    }

    get state() {
        if (this._state === undefined)
            this._state = false;
        return this._state;
    }

    get screenshare() {
        return this._screenshare;
    }

    connected() {
        super.connected();
        if (this._disconnectTimerId !== 0) {
            GLib.Source.remove(this._disconnectTimerId);
            this._disconnectTimerId = 0;
        }
        this._sendState();
    }

    disconnected() {
        super.disconnected();
        this._state = false;
        this.notify('state');

        if (this._screenshare && this._disconnectTimerId === 0) {
            this._disconnectTimerId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                5,
                () => {
                    this._disconnectTimerId = 0;
                    if (!this.device.connected)
                        this._stopScreenSharing(false);
                    return GLib.SOURCE_REMOVE;
                }
            );
        }
    }

    handlePacket(packet) {
        switch (packet.type) {
            case 'kdeconnect.mousepad.request':
                this._handleInput(packet.body);
                break;
            case 'kdeconnect.mousepad.echo':
                this._handleEcho(packet.body);
                break;
            case 'kdeconnect.mousepad.keyboardstate':
                this._handleState(packet);
                break;
            case 'kdeconnect.mousepad.screenshare':
                this._handleScreenSharePacket(packet.body);
                break;
        }
    }

    _handleState(packet) {
        if (this.state !== Boolean(packet.body.state)) {
            this._state = Boolean(packet.body.state);
            this.notify('state');
        }
    }

    _updateViewport(body) {
        if (typeof body.viewWidthMm === 'number' && body.viewWidthMm > 0 &&
            typeof body.viewHeightMm === 'number' && body.viewHeightMm > 0) {
            this._phoneViewMm = [body.viewWidthMm, body.viewHeightMm];
            this._cropDirty = true;
        }
    }

    _handleInput(input) {
        if (!this.settings.get_boolean('share-control'))
            return;

        let keysym;
        let modifiers = 0;
        const modifiers_codes = [];

        switch (true) {
            case input.hasOwnProperty('scroll'):
                this._input.scrollPointer(input.dx, input.dy);
                break;

            case (input.hasOwnProperty('dx') && input.hasOwnProperty('dy')): {
                let dx = input.dx;
                let dy = input.dy;

                if (this._screenshare && input.deltaInMm) {
                    const pxPerMmX = this._streamLogicalSize[0] / this._monitorMm[0];
                    const pxPerMmY = this._streamLogicalSize[1] / this._monitorMm[1];
                    dx = input.dx * pxPerMmX;
                    dy = input.dy * pxPerMmY;
                }

                this._fracX += dx;
                this._fracY += dy;
                const moveX = Math.trunc(this._fracX);
                const moveY = Math.trunc(this._fracY);
                this._fracX -= moveX;
                this._fracY -= moveY;

                if (moveX !== 0 || moveY !== 0) {
                    this._input.movePointer(moveX, moveY);
                    if (this._screenshare) {
                        const [w, h] = this._streamLogicalSize;
                        this._cursorLogical = [
                            Math.max(0, Math.min(w, this._cursorLogical[0] + moveX)),
                            Math.max(0, Math.min(h, this._cursorLogical[1] + moveY)),
                        ];
                        this._cropDirty = true;
                    }
                }
                break;
            }

            case (input.hasOwnProperty('key') || input.hasOwnProperty('specialKey')):
                if (input.key && input.key === '\u0000')
                    return;
                if (input.alt) {
                    modifiers |= Gdk.ModifierType.MOD1_MASK;
                    modifiers_codes.push(56);
                }
                if (input.ctrl) {
                    modifiers |= Gdk.ModifierType.CONTROL_MASK;
                    modifiers_codes.push(29);
                }
                if (input.shift) {
                    modifiers |= Gdk.ModifierType.SHIFT_MASK;
                    modifiers_codes.push(42);
                }
                if (input.super) {
                    modifiers |= Gdk.ModifierType.SUPER_MASK;
                    modifiers_codes.push(125);
                }

                if (input.key) {
                    if (!globalThis.HAVE_GNOME)
                        this._input.pressKeys(input.key, modifiers_codes);
                    else
                        this._input.pressKeys(input.key, modifiers);
                    this._sendEcho(input);
                } else if (input.specialKey && KeyMap.has(input.specialKey)) {
                    if (!globalThis.HAVE_GNOME) {
                        keysym = KeyMapCodes.get(input.specialKey);
                        this._input.pressKeys(keysym, modifiers_codes);
                    } else {
                        keysym = KeyMap.get(input.specialKey);
                        this._input.pressKeys(keysym, modifiers);
                    }
                    this._sendEcho(input);
                }
                break;

            case input.hasOwnProperty('singleclick'):
                this._input.clickPointer(Gdk.BUTTON_PRIMARY);
                break;
            case input.hasOwnProperty('doubleclick'):
                this._input.doubleclickPointer(Gdk.BUTTON_PRIMARY);
                break;
            case input.hasOwnProperty('middleclick'):
                this._input.clickPointer(Gdk.BUTTON_MIDDLE);
                break;
            case input.hasOwnProperty('rightclick'):
                this._input.clickPointer(Gdk.BUTTON_SECONDARY);
                break;
            case input.hasOwnProperty('singlehold'):
                this._input.pressPointer(Gdk.BUTTON_PRIMARY);
                break;
            case input.hasOwnProperty('singlerelease'):
                this._input.releasePointer(Gdk.BUTTON_PRIMARY);
                break;
            default:
                logError(new Error('Unknown input'));
        }
    }

    _getTokenFile() {
        const dir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gsconnect']);
        GLib.mkdir_with_parents(dir, 0o700);
        return GLib.build_filenamev([dir, `screenshare_token_${this.device.id}`]);
    }

    _loadRestoreToken() {
        try {
            const [ok, bytes] = GLib.file_get_contents(this._getTokenFile());
            if (ok) {
                const token = new TextDecoder().decode(bytes).trim();
                return token.length > 0 ? token : null;
            }
        } catch {}
        return null;
    }

    _saveRestoreToken(token) {
        try {
            GLib.file_set_contents(this._getTokenFile(), token);
        } catch (e) {
            logError(e, 'Failed to save screenshare restore token');
        }
    }

    _pollLiveCursorPosition() {
        if (this._shellPointerAvailable && !this._pollingPointer) {
            this._pollingPointer = true;
            Gio.DBus.session.call(
                SHELL_BUS_NAME,
                SHELL_POINTER_PATH,
                SHELL_POINTER_IFACE,
                'GetPosition',
                null,
                new GLib.VariantType('(dd)'),
                Gio.DBusCallFlags.NONE,
                100,
                null,
                (conn, res) => {
                    this._pollingPointer = false;
                    try {
                        const [gx, gy] = conn.call_finish(res).deepUnpack();
                        const lx = gx - this._streamPos[0];
                        const ly = gy - this._streamPos[1];
                        if (Math.abs(lx - this._cursorLogical[0]) >= 0.5 ||
                            Math.abs(ly - this._cursorLogical[1]) >= 0.5) {
                            this._cursorLogical = [lx, ly];
                            this._cropDirty = true;
                        }
                    } catch (e) {
                        console.warn(`[GSConnect Mousepad] Shell Pointer unavailable: ${e.message}`);
                        this._shellPointerAvailable = false;
                    }
                }
            );
        }
    }

    _detectMonitorPhysicalSize(streamPos, streamSize, hasStreamPos) {
        const [sx, sy] = streamPos;
        const [sw, sh] = streamSize;
        try {
            const display = Gdk.Display.get_default();
            const monitors = [];
            if (display) {
                if (typeof display.get_n_monitors === 'function') {
                    for (let i = 0; i < display.get_n_monitors(); i++)
                        monitors.push(display.get_monitor(i));
                } else if (typeof display.get_monitors === 'function') {
                    const list = display.get_monitors();
                    for (let i = 0; i < list.get_n_items(); i++)
                        monitors.push(list.get_item(i));
                }
            }
            if (hasStreamPos) {
                for (const mon of monitors) {
                    const geom = mon.get_geometry();
                    if (geom.x === sx && geom.y === sy && mon.get_width_mm() > 0 && mon.get_height_mm() > 0)
                        return [mon.get_width_mm(), mon.get_height_mm()];
                }
            }
            for (const mon of monitors) {
                const geom = mon.get_geometry();
                if (geom.width === sw && geom.height === sh && mon.get_width_mm() > 0 && mon.get_height_mm() > 0)
                    return [mon.get_width_mm(), mon.get_height_mm()];
            }
        } catch (e) {
            logError(e, 'Monitor physical size lookup fallback');
        }
        return [sw * FALLBACK_MM_PER_PX, sh * FALLBACK_MM_PER_PX];
    }

    _computeFixedOutputSize() {
        const [viewWmm, viewHmm] = this._phoneViewMm;
        const aspect = viewWmm / viewHmm;
        let outW, outH;

        if (aspect >= 1) {
            outW = SCREENSHARE_MAX_OUT_DIM;
            outH = Math.round(SCREENSHARE_MAX_OUT_DIM / aspect);
        } else {
            outH = SCREENSHARE_MAX_OUT_DIM;
            outW = Math.round(SCREENSHARE_MAX_OUT_DIM * aspect);
        }

        outW = Math.max(64, outW - (outW % 2));
        outH = Math.max(64, outH - (outH % 2));
        return [outW, outH];
    }

    _applyCrop() {
        if (!this._videobox)
            return;

        const [streamW, streamH] = this._streamPixelSize;
        if (streamW <= 0 || streamH <= 0)
            return;

        const [monWmm, monHmm] = this._monitorMm;
        const [viewWmm, viewHmm] = this._phoneViewMm;

        let cropW = Math.round(streamW * (viewWmm / monWmm) * SCREENSHARE_ZOOM_OUT);
        let cropH = Math.round(streamH * (viewHmm / monHmm) * SCREENSHARE_ZOOM_OUT);
        cropW = Math.min(streamW, Math.max(64, cropW - (cropW % 2)));
        cropH = Math.min(streamH, Math.max(64, cropH - (cropH % 2)));

        const scaleX = streamW / this._streamLogicalSize[0];
        const scaleY = streamH / this._streamLogicalSize[1];
        const cursorPxX = this._cursorLogical[0] * scaleX;
        const cursorPxY = this._cursorLogical[1] * scaleY;

        let left = Math.round(cursorPxX - 0.5 * cropW);
        let top = Math.round(cursorPxY - 0.5 * cropH);
        left -= (left % 2);
        top -= (top % 2);

        const right = streamW - cropW - left;
        const bottom = streamH - cropH - top;

        this._videobox.freeze_notify();
        try {
            if (this._boxLeft === null || left <= this._boxLeft) {
                this._videobox.left = left;
                this._videobox.right = right;
            } else {
                this._videobox.right = right;
                this._videobox.left = left;
            }
            this._boxLeft = left;

            if (this._boxTop === null || top <= this._boxTop) {
                this._videobox.top = top;
                this._videobox.bottom = bottom;
            } else {
                this._videobox.bottom = bottom;
                this._videobox.top = top;
            }
            this._boxTop = top;
        } finally {
            this._videobox.thaw_notify();
        }
        this._cropDirty = false;
    }

    _getLocalIpAddress() {
        try {
            const sock = Gio.Socket.new(
                Gio.SocketFamily.IPV4,
                Gio.SocketType.DATAGRAM,
                Gio.SocketProtocol.UDP
            );
            sock.connect(Gio.InetSocketAddress.new_from_string('8.8.8.8', 53), null);
            const ip = sock.get_local_address().get_address().to_string();
            sock.close();
            return ip;
        } catch {
            return null;
        }
    }

    _openTcpServer() {
        const server = new Gio.SocketService();
        let boundPort = 0;

        for (let port = STREAM_PORT_MIN; port <= STREAM_PORT_MAX; port++) {
            try {
                server.add_inet_port(port, null);
                boundPort = port;
                break;
            } catch {
                // Port in use, try next
            }
        }

        if (boundPort === 0)
            boundPort = server.add_any_inet_port(null);

        server.connect('incoming', (_svc, connection) => {
            if (!this._screenshare) {
                connection.close(null);
                return true;
            }

            if (this._streamConnection) {
                try {
                    this._streamConnection.close(null);
                } catch {}
            }

            const socket = connection.get_socket();
            socket.set_option(6, 1, 1); // IPPROTO_TCP (6), TCP_NODELAY (1)

            this._streamConnection = connection;
            this._streamOut = connection.get_output_stream();
            this._writingFrame = false;

            if (this._pipeline)
                this._pipeline.set_state(Gst.State.PLAYING);

            return true;
        });

        server.start();
        this._tcpServer = server;
        return boundPort;
    }

    _handleEcho(input) {
        if (!this._dialog || !this._dialog.visible)
            return;
        if (input.alt || input.ctrl || input.super)
            return;
        if (input.key) {
            this._dialog._isAck = true;
            this._dialog.entry.buffer.text += input.key;
            this._dialog._isAck = false;
        } else if (KeyMap.get(input.specialKey) === Gdk.KEY_BackSpace) {
            this._dialog.entry.emit('backspace');
        }
    }

    async _handleScreenSharePacket(body) {
        if (!this.settings.get_boolean('share-screen'))
            return;

        this._updateViewport(body);

        if (body.switchScreen) {
            await this._stopScreenSharing(false);
            this._startScreenSharing(true);
        } else if (body.startScreenShare) {
            this._startScreenSharing(false);
        } else if (body.stopScreenShare || body.stop) {
            this._stopScreenSharing(false);
        }
    }

    _sendEcho(input) {
        if (!input.sendAck)
            return;
        delete input.sendAck;
        input.isAck = true;
        if (this.device.connected) {
            try {
                this.device.sendPacket({type: 'kdeconnect.mousepad.echo', body: input});
            } catch {}
        }
    }

    _sendState() {
        if (this.device.connected) {
            try {
                this.device.sendPacket({
                    type: 'kdeconnect.mousepad.keyboardstate',
                    body: {state: this.settings.get_boolean('share-control')},
                });
            } catch {}
        }
    }

    keyboard() {
        if (this._dialog === undefined)
            this._dialog = new InputDialog({device: this.device, plugin: this});
        this._dialog.present();
    }

    screenShare() {
        if (this._screenshare)
            this._stopScreenSharing();
        else
            this._startScreenSharing(false);
    }

    _portalRequest(method, signature, prefixArgs, options) {
        return new Promise((resolve, reject) => {
            const token = `gsconnect_${GLib.random_int_range(100000, 999999)}`;
            const sender = Gio.DBus.session.get_unique_name().slice(1).replace(/\./g, '_');
            const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;
            options.handle_token = new GLib.Variant('s', token);

            const subId = Gio.DBus.session.signal_subscribe(
                PORTAL_BUS_NAME, REQUEST_IFACE, 'Response', requestPath, null,
                Gio.DBusSignalFlags.NO_MATCH_RULE,
                (_conn, _sender, _path, _iface, _signal, params) => {
                    Gio.DBus.session.signal_unsubscribe(subId);
                    const [response, results] = params.deepUnpack();
                    if (response === 0)
                        resolve(results);
                    else
                        reject(new Error(`Portal ${method} cancelled or failed (${response})`));
                }
            );

            Gio.DBus.session.call(
                PORTAL_BUS_NAME, PORTAL_OBJECT_PATH, SCREENCAST_IFACE, method,
                new GLib.Variant(signature, [...prefixArgs, options]),
                new GLib.VariantType('(o)'), Gio.DBusCallFlags.NONE, -1, null,
                (conn, res) => {
                    try {
                        conn.call_finish(res);
                    } catch (e) {
                        Gio.DBus.session.signal_unsubscribe(subId);
                        reject(e);
                    }
                }
            );
        });
    }

    async _startScreenSharing(forcePrompt = false) {
        if (!this.settings.get_boolean('share-screen') || this._screenshare || this._startingScreenShare)
            return;

        this._startingScreenShare = true;
        this._screenshare = true;
        this.notify('screenshare');

        let pwFd = -1;

        try {
            const sessionToken = `gsconnect_sess_${GLib.random_int_range(100000, 999999)}`;
            const createRes = await this._portalRequest(
                'CreateSession', '(a{sv})', [],
                {session_handle_token: new GLib.Variant('s', sessionToken)}
            );
            this._portalSessionPath = createRes.session_handle.deepUnpack();

            const selectOptions = {
                types: new GLib.Variant('u', 1),
                cursor_mode: new GLib.Variant('u', 2),
                persist_mode: new GLib.Variant('u', 2),
            };
            const savedToken = forcePrompt ? null : this._loadRestoreToken();
            if (savedToken)
                selectOptions.restore_token = new GLib.Variant('s', savedToken);

            await this._portalRequest(
                'SelectSources', '(oa{sv})', [this._portalSessionPath],
                selectOptions
            );

            const startRes = await this._portalRequest(
                'Start', '(osa{sv})', [this._portalSessionPath, ''], {}
            );

            if (startRes.restore_token)
                this._saveRestoreToken(startRes.restore_token.deepUnpack());

            const streams = startRes.streams.deepUnpack();
            if (!streams.length)
                throw new Error('No screen stream selected');

            const [nodeId, streamProps] = streams[0];
            const hasStreamPos = Boolean(streamProps.position);
            this._streamPos = hasStreamPos ? streamProps.position.deepUnpack() : [0, 0];
            this._streamLogicalSize = streamProps.size ? streamProps.size.deepUnpack() : [1920, 1080];
            this._monitorMm = this._detectMonitorPhysicalSize(
                this._streamPos, this._streamLogicalSize, hasStreamPos
            );

            this._shellPointerAvailable = true;
            this._fracX = 0;
            this._fracY = 0;
            this._cursorLogical = [
                this._streamLogicalSize[0] * 0.5,
                this._streamLogicalSize[1] * 0.5,
            ];
            this._pollLiveCursorPosition();

            const [fdReply, fdList] = await new Promise((resolve, reject) => {
                Gio.DBus.session.call_with_unix_fd_list(
                    PORTAL_BUS_NAME, PORTAL_OBJECT_PATH, SCREENCAST_IFACE,
                    'OpenPipeWireRemote',
                    new GLib.Variant('(oa{sv})', [this._portalSessionPath, {}]),
                    new GLib.VariantType('(h)'), Gio.DBusCallFlags.NONE, -1, null, null,
                    (conn, res) => {
                        try {
                            resolve(conn.call_with_unix_fd_list_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            pwFd = fdList.steal_fds()[fdReply.deepUnpack()[0]];
            if (!this._screenshare) {
                try { GLib.close(pwFd); } catch {}
                pwFd = -1;
                return;
            }

            const streamPort = this._openTcpServer();
            const streamHost = this._getLocalIpAddress();
            const [outW, outH] = this._computeFixedOutputSize();

            this._streamPixelSize = [...this._streamLogicalSize];

            const pipelineDesc =
                `pipewiresrc fd=${pwFd} path=${nodeId} do-timestamp=true ! ` +
                `videorate ! video/x-raw,framerate=${SCREENSHARE_FPS}/1 ! ` +
                `videoconvert n-threads=0 ! video/x-raw,format=BGRx ! ` +
                `videobox name=box fill=black ! ` +
                `videoscale n-threads=0 method=bilinear ! video/x-raw,width=${outW},height=${outH} ! ` +
                `videoconvert n-threads=0 ! video/x-raw,format=I420 ! ` +
                `queue max-size-buffers=1 leaky=downstream ! ` +
                `x264enc tune=zerolatency speed-preset=ultrafast bitrate=${SCREENSHARE_BITRATE_KBPS} ` +
                `intra-refresh=true sliced-threads=true vbv-buf-capacity=100 key-int-max=60 ! ` +
                `h264parse config-interval=-1 ! ` +
                `video/x-h264,stream-format=byte-stream,alignment=au ! ` +
                `appsink name=sink emit-signals=false max-buffers=2 drop=false sync=false`;

            this._pipeline = Gst.parse_launch(pipelineDesc);
            pwFd = -1;

            this._videobox = this._pipeline.get_by_name('box');
            this._appsink = this._pipeline.get_by_name('sink');
            this._boxSinkPad = this._videobox.get_static_pad('sink');
            this._boxLeft = null;
            this._boxTop = null;
            this._applyCrop();

            if (this.device.connected) {
                this.device.sendPacket({
                    type: 'kdeconnect.mousepad.screenshare',
                    body: {
                        startScreenShare: true,
                        codec: 'h264',
                        streamHost,
                        streamPort,
                        width: outW,
                        height: outH,
                    },
                });
            }

            let pollTick = 0;
            this._screenShareTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                10,
                () => {
                    if (!this._screenshare || !this._appsink) {
                        this._screenShareTimerId = 0;
                        return GLib.SOURCE_REMOVE;
                    }
                    if (++pollTick % 3 === 0)
                        this._pollLiveCursorPosition();
                    this._pullPipelineBusErrors();
                    this._pullAndSendFrame();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        } catch (e) {
            if (pwFd !== -1) {
                try { GLib.close(pwFd); } catch {}
            }
            logError(e, 'Screen sharing failed to start');
            await this._stopScreenSharing(false);
        } finally {
            this._startingScreenShare = false;
        }
    }

    _pullPipelineBusErrors() {
        if (!this._pipeline)
            return;
        const bus = this._pipeline.get_bus();
        if (!bus)
            return;

        let msg;
        while ((msg = bus.pop_filtered(Gst.MessageType.ERROR | Gst.MessageType.WARNING)) !== null) {
            if (msg.type === Gst.MessageType.ERROR) {
                const [err, dbg] = msg.parse_error();
                logError(err, `GStreamer screenshare error: ${dbg}`);
                this._stopScreenSharing(true);
                break;
            }
        }
    }

    _pullAndSendFrame() {
        if (!this._screenshare || !this._appsink || !this._streamOut)
            return;

        if (this._boxSinkPad) {
            const sinkCaps = this._boxSinkPad.get_current_caps();
            const sinkStruct = sinkCaps ? sinkCaps.get_structure(0) : null;
            if (sinkStruct) {
                const [okW, w] = sinkStruct.get_int('width');
                const [okH, h] = sinkStruct.get_int('height');
                if (okW && okH && w > 0 && h > 0 &&
                    (w !== this._streamPixelSize[0] || h !== this._streamPixelSize[1])) {
                    this._streamPixelSize = [w, h];
                    this._applyCrop();
                }
            }
        }

        if (this._cropDirty)
            this._applyCrop();

        if (this._writingFrame)
            return;

        const sample = this._appsink.try_pull_sample(0);
        if (!sample)
            return;

        const buffer = sample.get_buffer();
        const [ok, mapInfo] = buffer.map(Gst.MapFlags.READ);
        if (!ok)
            return;

        try {
            const raw = mapInfo.data instanceof Uint8Array
                ? mapInfo.data
                : new Uint8Array(mapInfo.data);
            const len = raw.byteLength;
            if (len === 0)
                return;

            const packet = new Uint8Array(4 + len);
            packet[0] = (len >>> 24) & 0xff;
            packet[1] = (len >>> 16) & 0xff;
            packet[2] = (len >>> 8) & 0xff;
            packet[3] = len & 0xff;
            packet.set(raw, 4);

            this._writingFrame = true;
            const out = this._streamOut;
            out.write_all_async(
                packet,
                GLib.PRIORITY_DEFAULT,
                null,
                (stream, res) => {
                    this._writingFrame = false;
                    try {
                        stream.write_all_finish(res);
                        if (this._screenshare)
                            this._pullAndSendFrame();
                    } catch {
                        if (this._streamOut === stream) {
                            this._streamOut = null;
                            this._streamConnection = null;
                        }
                    }
                }
            );
        } finally {
            buffer.unmap(mapInfo);
        }
    }

    async _stopScreenSharing(notifyDevice = true) {
        if (this._disconnectTimerId !== 0) {
            GLib.Source.remove(this._disconnectTimerId);
            this._disconnectTimerId = 0;
        }
        if (this._screenShareTimerId !== 0) {
            if (GLib.MainContext.default().find_source_by_id(this._screenShareTimerId))
                GLib.Source.remove(this._screenShareTimerId);
            this._screenShareTimerId = 0;
        }
        if (this._pipeline !== null) {
            this._pipeline.set_state(Gst.State.NULL);
            this._pipeline = null;
            this._appsink = null;
            this._videobox = null;
            this._boxSinkPad = null;
        }
        if (this._streamConnection !== null) {
            try { this._streamConnection.close(null); } catch {}
            this._streamConnection = null;
            this._streamOut = null;
            this._writingFrame = false;
        }
        if (this._tcpServer !== null) {
            this._tcpServer.stop();
            this._tcpServer.close();
            this._tcpServer = null;
        }

        this._streamPixelSize = [0, 0];
        this._cropDirty = false;
        this._boxLeft = null;
        this._boxTop = null;

        if (this._portalSessionPath !== null) {
            const path = this._portalSessionPath;
            this._portalSessionPath = null;
            await new Promise((resolve) => {
                Gio.DBus.session.call(
                    PORTAL_BUS_NAME, path, SESSION_IFACE, 'Close',
                    null, null, Gio.DBusCallFlags.NONE, -1, null, () => resolve()
                );
            });
        }

        if (!this._screenshare)
            return;

        this._screenshare = false;
        this.notify('screenshare');

        if (notifyDevice && this.device.connected) {
            try {
                this.device.sendPacket({
                    type: 'kdeconnect.mousepad.screenshare',
                    body: {stopScreenShare: true},
                });
            } catch {}
        }
    }

    destroy() {
        if (this._disconnectTimerId !== 0) {
            GLib.Source.remove(this._disconnectTimerId);
            this._disconnectTimerId = 0;
        }
        this._stopScreenSharing(false);

        if (this._input !== undefined) {
            if (!globalThis.HAVE_GNOME)
                this._input = Components.release('ydotool');
            else
                this._input = Components.release('input');
        }
        if (this._dialog !== undefined)
            this._dialog.destroy();

        this.settings.disconnect(this._shareControlChangedId);
        this.settings.disconnect(this._shareScreenChangedId);
        super.destroy();
    }
});

export default MousepadPlugin;
