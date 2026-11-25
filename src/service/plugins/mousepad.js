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

const SCREENSHARE_FPS = 5;
const SCREENSHARE_JPEG_QUALITY = 65;
const PORTAL_BUS_NAME = 'org.freedesktop.portal.Desktop';
const PORTAL_OBJECT_PATH = '/org/freedesktop/portal/desktop';
const SCREENCAST_IFACE = 'org.freedesktop.portal.ScreenCast';
const REQUEST_IFACE = 'org.freedesktop.portal.Request';
const SESSION_IFACE = 'org.freedesktop.portal.Session';


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

/**
 * A map of "KDE Connect" keyvals to Gdk
 */
const KeyMap = new Map([
    [1, Gdk.KEY_BackSpace],
    [2, Gdk.KEY_Tab],
    [3, Gdk.KEY_Linefeed],
    [4, Gdk.KEY_Left],
    [5, Gdk.KEY_Up],
    [6, Gdk.KEY_Right],
    [7, Gdk.KEY_Down],
    [8, Gdk.KEY_Page_Up],
    [9, Gdk.KEY_Page_Down],
    [10, Gdk.KEY_Home],
    [11, Gdk.KEY_End],
    [12, Gdk.KEY_Return],
    [13, Gdk.KEY_Delete],
    [14, Gdk.KEY_Escape],
    [15, Gdk.KEY_Sys_Req],
    [16, Gdk.KEY_Scroll_Lock],
    [17, 0],
    [18, 0],
    [19, 0],
    [20, 0],
    [21, Gdk.KEY_F1],
    [22, Gdk.KEY_F2],
    [23, Gdk.KEY_F3],
    [24, Gdk.KEY_F4],
    [25, Gdk.KEY_F5],
    [26, Gdk.KEY_F6],
    [27, Gdk.KEY_F7],
    [28, Gdk.KEY_F8],
    [29, Gdk.KEY_F9],
    [30, Gdk.KEY_F10],
    [31, Gdk.KEY_F11],
    [32, Gdk.KEY_F12],
]);

const KeyMapCodes = new Map([
    [1, 14],
    [2, 15],
    [3, 101],
    [4, 105],
    [5, 103],
    [6, 106],
    [7, 108],
    [8, 104],
    [9, 109],
    [10, 102],
    [11, 107],
    [12, 28],
    [13, 111],
    [14, 1],
    [15, 99],
    [16, 70],
    [17, 0],
    [18, 0],
    [19, 0],
    [20, 0],
    [21, 59],
    [22, 60],
    [23, 61],
    [24, 62],
    [25, 63],
    [26, 64],
    [27, 65],
    [28, 66],
    [29, 67],
    [30, 68],
    [31, 87],
    [32, 88],
]);

/**
 * Mousepad Plugin
 * https://github.com/KDE/kdeconnect-kde/tree/master/plugins/mousepad
 */
const MousepadPlugin = GObject.registerClass({
    GTypeName: 'GSConnectMousepadPlugin',
    Properties: {
        'state': GObject.ParamSpec.boolean(
            'state',
            'State',
            'Remote keyboard state',
            GObject.ParamFlags.READABLE,
            false
        ),
        'screenshare': GObject.ParamSpec.boolean(
            'screenshare',
            'Screenshare',
            'Screen sharing mode',
            GObject.ParamFlags.READABLE,
            false
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
        this._screenShareTimerId = 0;
        this._pipeline = null;
        this._appsink = null;
        this._portalSessionPath = null;
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

        this._sendState();
    }

    disconnected() {
        super.disconnected();

        this._state = false;
        this.notify('state');
        this._stopScreenSharing(false);
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

    /**
     * Handle a input event.
     *
     * @param {object} input - The body of a `kdeconnect.mousepad.request`
     */
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

            case (input.hasOwnProperty('dx') && input.hasOwnProperty('dy')):
                this._input.movePointer(input.dx, input.dy);
                break;

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

    /**
     * Handle an echo/ACK of an event we sent, displaying it in the dialog entry.
     *
     * @param {object} input - The body of a `kdeconnect.mousepad.echo`
     */
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

    /**
     * Handle incoming screen share control packets from the mobile device
     *
     * @param {object} body - The body of a `kdeconnect.mousepad.screenshare` packet
     */
    _handleScreenSharePacket(body) {
        if (!this.settings.get_boolean('share-screen'))
            return;

        if (body.switchScreen) {
            this._stopScreenSharing(false);
            this._startScreenSharing();
        } else if (body.startScreenShare) {
            this._startScreenSharing();
        } else if (body.stopScreenShare || body.stop) {
            this._stopScreenSharing(false);
        }
    }

    /**
     * Send an echo/ACK of {@link input}, if requested
     *
     * @param {object} input - The body of a 'kdeconnect.mousepad.request'
     */
    _sendEcho(input) {
        if (!input.sendAck)
            return;

        delete input.sendAck;
        input.isAck = true;

        this.device.sendPacket({
            type: 'kdeconnect.mousepad.echo',
            body: input,
        });
    }

    /**
     * Send the local keyboard state
     */
    _sendState() {
        this.device.sendPacket({
            type: 'kdeconnect.mousepad.keyboardstate',
            body: {
                state: this.settings.get_boolean('share-control'),
            },
        });
    }

    /**
     * Open the Keyboard Input dialog
     */
    keyboard() {
        if (this._dialog === undefined) {
            this._dialog = new InputDialog({
                device: this.device,
                plugin: this,
            });
        }

        this._dialog.present();
    }

    /**
     * Toggle PC -> Phone screen sharing from the device menu
     */
    screenShare() {
        if (this._screenshare)
            this._stopScreenSharing();
        else
            this._startScreenSharing();
    }

    /**
     * Helper to call an XDG Portal method and await its Response signal
     */
    _portalRequest(method, signature, prefixArgs, options) {
        return new Promise((resolve, reject) => {
            const token = `gsconnect_${GLib.random_int_range(100000, 999999)}`;
            const sender = Gio.DBus.session.get_unique_name().slice(1).replace(/\./g, '_');
            const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${token}`;

            options.handle_token = new GLib.Variant('s', token);

            const subId = Gio.DBus.session.signal_subscribe(
                PORTAL_BUS_NAME,
                REQUEST_IFACE,
                'Response',
                requestPath,
                null,
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
                PORTAL_BUS_NAME,
                PORTAL_OBJECT_PATH,
                SCREENCAST_IFACE,
                method,
                new GLib.Variant(signature, [...prefixArgs, options]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
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

    /**
     * Start capturing and streaming the desktop via XDG ScreenCast Portal + GStreamer
     */
    async _startScreenSharing() {
        if (!this.settings.get_boolean('share-screen') || this._screenshare)
            return;

        this._screenshare = true;
        this.notify('screenshare');

        try {
            // 1. Create Portal Session
            const sessionToken = `gsconnect_sess_${GLib.random_int_range(100000, 999999)}`;
            const createRes = await this._portalRequest(
                'CreateSession',
                '(a{sv})',
                [],
                {session_handle_token: new GLib.Variant('s', sessionToken)}
            );
            this._portalSessionPath = createRes.session_handle.deepUnpack();

            // 2. Select Sources (type: 1 = Monitor, cursor_mode: 2 = Embedded)
            await this._portalRequest(
                'SelectSources',
                '(oa{sv})',
                [this._portalSessionPath],
                {
                    types: new GLib.Variant('u', 1),
                    cursor_mode: new GLib.Variant('u', 2),
                }
            );

            // 3. Start Session (opens GNOME's native screen-sharing dialog)
            const startRes = await this._portalRequest(
                'Start',
                '(osa{sv})',
                [this._portalSessionPath, ''],
                {}
            );

            const streams = startRes.streams.deepUnpack();
            if (!streams.length)
                throw new Error('No screen stream selected');

            const nodeId = streams[0][0];

            // 4. Open PipeWire Remote FD
            const [fdReply, fdList] = await new Promise((resolve, reject) => {
                Gio.DBus.session.call_with_unix_fd_list(
                    PORTAL_BUS_NAME,
                    PORTAL_OBJECT_PATH,
                    SCREENCAST_IFACE,
                    'OpenPipeWireRemote',
                    new GLib.Variant('(oa{sv})', [this._portalSessionPath, {}]),
                    new GLib.VariantType('(h)'),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    null,
                    (conn, res) => {
                        try {
                            resolve(conn.call_with_unix_fd_list_finish(res));
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            const fdIndex = fdReply.deepUnpack()[0];
            const pwFd = fdList.steal_fds()[fdIndex];

            if (!this._screenshare)
                return;

            // 5. Build and start GStreamer pipeline (force I420 for jpegenc)
            const pipelineDesc =
                `pipewiresrc fd=${pwFd} path=${nodeId} do-timestamp=true ! ` +
                `videorate ! video/x-raw,framerate=${SCREENSHARE_FPS}/1 ! ` +
                `videoconvert ! video/x-raw,format=I420 ! ` +
                `jpegenc quality=${SCREENSHARE_JPEG_QUALITY} ! ` +
                `appsink name=sink max-buffers=1 drop=true sync=false`;

            this._pipeline = Gst.parse_launch(pipelineDesc);
            this._appsink = this._pipeline.get_by_name('sink');
            this._pipeline.set_state(Gst.State.PLAYING);

            this.device.sendPacket({
                type: 'kdeconnect.mousepad.screenshare',
                body: {startScreenShare: true},
            });

            // 6. Poll appsink on the main loop and send frames
            const intervalMs = Math.round(1000 / SCREENSHARE_FPS);
            this._screenShareTimerId = GLib.timeout_add(
                GLib.PRIORITY_DEFAULT,
                intervalMs,
                () => {
                    if (!this._screenshare || !this._appsink)
                        return GLib.SOURCE_REMOVE;

                    this._pullAndSendFrame();
                    return GLib.SOURCE_CONTINUE;
                }
            );
        } catch (e) {
            logError(e, 'Screen sharing failed to start');
            this._stopScreenSharing(false);
        }
    }

    /**
     * Pull the latest JPEG frame from GStreamer appsink and send it
     */
    _pullAndSendFrame() {
        const sample = this._appsink.try_pull_sample(0);
        if (!sample)
            return;

        const buffer = sample.get_buffer();
        const caps = sample.get_caps();
        const structure = caps ? caps.get_structure(0) : null;
        const width = structure ? structure.get_int('width')[1] : 0;
        const height = structure ? structure.get_int('height')[1] : 0;

        const [ok, mapInfo] = buffer.map(Gst.MapFlags.READ);
        if (ok) {
            try {
                this.device.sendPacket({
                    type: 'kdeconnect.mousepad.screenshare',
                    body: {
                        screenData: GLib.base64_encode(mapInfo.data),
                        format: 'jpeg',
                        width,
                        height,
                    },
                });
            } finally {
                buffer.unmap(mapInfo);
            }
        }
    }

    /**
     * Stop GStreamer pipeline, close Portal session, and notify the device
     */
    _stopScreenSharing(notifyDevice = true) {
        if (this._screenShareTimerId !== 0) {
            GLib.Source.remove(this._screenShareTimerId);
            this._screenShareTimerId = 0;
        }

        if (this._pipeline !== null) {
            this._pipeline.set_state(Gst.State.NULL);
            this._pipeline = null;
            this._appsink = null;
        }

        if (this._portalSessionPath !== null) {
            Gio.DBus.session.call(
                PORTAL_BUS_NAME,
                this._portalSessionPath,
                SESSION_IFACE,
                'Close',
                null,
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                null
            );
            this._portalSessionPath = null;
        }

        if (!this._screenshare)
            return;

        this._screenshare = false;
        this.notify('screenshare');

        if (notifyDevice) {
            this.device.sendPacket({
                type: 'kdeconnect.mousepad.screenshare',
                body: {stopScreenShare: true},
            });
        }
    }

    destroy() {
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
