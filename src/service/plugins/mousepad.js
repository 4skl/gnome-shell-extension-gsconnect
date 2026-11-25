// SPDX-FileCopyrightText: GSConnect Developers https://github.com/GSConnect
//
// SPDX-License-Identifier: GPL-2.0-or-later

import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';

import * as Components from '../components/index.js';
import {InputDialog} from '../ui/mousepad.js';
import Plugin from '../plugin.js';


export const Metadata = {
    label: _('Mousepad'),
    description: _('Enables the paired device to act as a remote mouse and keyboard'),
    id: 'org.gnome.Shell.Extensions.GSConnect.Plugin.Mousepad',
    incomingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate',
        'kdeconnect.presenter',
    ],
    outgoingCapabilities: [
        'kdeconnect.mousepad.echo',
        'kdeconnect.mousepad.request',
        'kdeconnect.mousepad.keyboardstate',
        'kdeconnect.presenter',
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
 *
 * TODO: support outgoing mouse events?
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
        
        this._screenshare = false;
        this._screenTexture = null;
        this._screenshareDialog = null;
        this._screenShareZoom = 1.0;
        this._screenSharePanX = 0;
        this._screenSharePanY = 0;
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
        this._screenshare = false;
        this.notify('screenshare');
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
                
            case 'kdeconnect.presenter':
                this._handlePresenterPacket(packet.body);
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

        // These are ordered, as much as possible, to create the shortest code
        // path for high-frequency, low-latency events (eg. mouse movement)
        switch (true) {
            case input.hasOwnProperty('scroll'):
                this._input.scrollPointer(input.dx, input.dy);
                break;

            case (input.hasOwnProperty('dx') && input.hasOwnProperty('dy')):
                this._input.movePointer(input.dx, input.dy);
                break;

            case (input.hasOwnProperty('key') || input.hasOwnProperty('specialKey')):
                // NOTE: \u0000 sometimes sent in advance of a specialKey packet
                if (input.key && input.key === '\u0000')
                    return;

                // Modifiers
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

                // Regular key (printable ASCII or Unicode)
                if (input.key) {
                    if (!globalThis.HAVE_GNOME)
                        this._input.pressKeys(input.key, modifiers_codes);
                    else
                        this._input.pressKeys(input.key, modifiers);

                    this._sendEcho(input);

                // Special key (eg. non-printable ASCII)
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
     * Handle an echo/ACK of a event we sent, displaying it the dialog entry.
     *
     * @param {object} input - The body of a `kdeconnect.mousepad.echo`
     */
    _handleEcho(input) {
        if (!this._dialog || !this._dialog.visible)
            return;

        // Skip modifiers
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
     * Handle a presenter packet for screen sharing
     *
     * @param {object} body - The body of a `kdeconnect.presenter` packet
     */
    _handlePresenterPacket(body) {
        if (body.hasOwnProperty('screenData')) {
            // Handle screen data (image)
            this._handleScreenData(body.screenData);
        } else if (body.hasOwnProperty('pointerPosition')) {
            // Handle pointer movement
            this._handlePointerPosition(body.pointerPosition);
        } else if (body.hasOwnProperty('zoom')) {
            // Handle zoom changes
            this._handleZoom(body.zoom);
        } else if (body.hasOwnProperty('pan')) {
            // Handle panning
            this._handlePan(body.pan);
        } else if (body.hasOwnProperty('startScreenShare')) {
            // Start screen sharing mode
            this._startScreenShare();
        } else if (body.hasOwnProperty('stopScreenShare')) {
            // Stop screen sharing mode
            this._stopScreenShare();
        }
    }

    /**
     * Handle screen data (image)
     *
     * @param {string} screenData - Base64 encoded screen image
     */
    _handleScreenData(screenData) {
        // This method will be called when screen data arrives
        // We need to update the screen sharing dialog with the new image
        if (this._screenshareDialog !== undefined && this._screenshare) {
            // Decode base64 screen data if needed
            let imageData;
            
            // Check if screenData is a base64 string that needs decoding
            if (typeof screenData === 'string' && screenData.startsWith('data:image')) {
                // Extract base64 data from data URL
                const base64Data = screenData.split(',')[1];
                imageData = GLib.base64_decode(base64Data);
            } else if (typeof screenData === 'string') {
                // Assume it's base64 encoded data
                try {
                    imageData = GLib.base64_decode(screenData);
                } catch (e) {
                    // If decoding fails, treat as raw data
                    imageData = screenData;
                }
            } else {
                // Already decoded data
                imageData = screenData;
            }
            
            // Update the screen image in the dialog
            this._screenshareDialog.handleScreenData(imageData);
        }
    }

    /**
     * Handle pointer position updates
     *
     * @param {object} position - Pointer position data
     */
    _handlePointerPosition(position) {
        // Handle pointer movement for screen sharing
        if (this._screenshareDialog && this._screenshareDialog.pointer) {
            // Update pointer position in the dialog
            this._screenshareDialog.pointer.x = position.x;
            this._screenshareDialog.pointer.y = position.y;
        }
    }

    /**
     * Handle zoom changes
     *
     * @param {number} zoom - Zoom level
     */
    _handleZoom(zoom) {
        this._screenShareZoom = zoom;
        if (this._screenshareDialog) {
            // Update zoom in the dialog
            this._screenshareDialog.updateZoom(zoom);
        }
    }

    /**
     * Handle panning
     *
     * @param {object} pan - Pan coordinates
     */
    _handlePan(pan) {
        this._screenSharePanX = pan.x;
        this._screenSharePanY = pan.y;
        if (this._screenshareDialog) {
            // Update pan in the dialog
            this._screenshareDialog.updatePan(pan.x, pan.y);
        }
    }

    /**
     * Start screen sharing mode
     */
    _startScreenShare() {
        this._screenshare = true;
        this.notify('screenshare');
        // Open screen sharing dialog
        this._openScreenShareDialog();
    }

    /**
     * Stop screen sharing mode
     */
    _stopScreenShare() {
        this._screenshare = false;
        this.notify('screenshare');
        // Close screen sharing dialog
        this._closeScreenShareDialog();
    }

    /**
     * Open the screen sharing dialog
     */
    _openScreenShareDialog() {
        if (this._screenshareDialog === undefined) {
            this._createScreenSharingDialog();
        }

        this._screenshareDialog.present();
    }

    /**
     * Close the screen sharing dialog
     */
    _closeScreenShareDialog() {
        if (this._screenshareDialog !== undefined) {
            this._screenshareDialog.destroy();
            this._screenshareDialog = undefined;
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
     * Start screen sharing mode
     */
    _startScreenSharing() {
        if (!this._screenshare) {
            this._screenshare = true;
            
            // Create or show the screen sharing dialog
            if (this._screenshareDialog === undefined) {
                this._createScreenSharingDialog();
            } else {
                this._screenshareDialog.present();
            }
            
            // Send a request to start screen sharing on the device
            this._sendScreenShareRequest();
        }
    }

    /**
     * Stop screen sharing mode
     */
    _stopScreenSharing() {
        if (this._screenshare) {
            this._screenshare = false;
            
            if (this._screenshareDialog !== undefined) {
                this._screenshareDialog.destroy();
                this._screenshareDialog = undefined;
            }
            
            // Send a stop signal to the device
            this.device.sendPacket({
                type: 'kdeconnect.presenter',
                body: {
                    stop: true
                }
            });
        }
    }

    /**
     * Create the screen sharing dialog
     */
    _createScreenSharingDialog() {
        // This is a placeholder - actual implementation would create the UI
        // For now, we'll just initialize the dialog reference
        this._screenshareDialog = new ScreenSharingDialog({
            device: this.device,
            plugin: this,
        });
    }

    /**
     * Update the screen image in the dialog
     */
    _updateScreenImage(screenData) {
        // This method will be implemented when the actual UI is created
        // It should update the displayed image with the new screen data
    }

    /**
     * Update pointer position on the screen
     */
    _updatePointerPosition(dx, dy) {
        // This method will be implemented when the actual UI is created
        // It should update the pointer position on the screen display
    }

    /**
     * Update zoom level
     */
    _updateZoomLevel(zoom) {
        // This method will be implemented when the actual UI is created
        // It should adjust the zoom level of the screen display
    }

    /**
     * Update pan position
     */
    _updatePanPosition(panX, panY) {
        // This method will be implemented when the actual UI is created
        // It should adjust the panning position of the screen display
    }

    /**
     * Send screen sharing request to the device
     */
    _sendScreenShareRequest() {
        // Request screen sharing from the device
        this.device.sendPacket({
            type: 'kdeconnect.presenter',
            body: {
                start: true
            }
        });
    }

    destroy() {
        if (this._input !== undefined) {
            if (!globalThis.HAVE_GNOME)
                this._input = Components.release('ydotool');
            else
                this._input = Components.release('input');
        }

        if (this._dialog !== undefined)
            this._dialog.destroy();

        if (this._screenshareDialog !== undefined)
            this._screenshareDialog.destroy();

        this.settings.disconnect(this._shareControlChangedId);

        super.destroy();
    }
});

export default MousepadPlugin;
