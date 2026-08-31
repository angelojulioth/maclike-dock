import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MaclikeDock} from './dock.js';

export default class MaclikeDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._dock = new MaclikeDock(this._settings, this.getLogger(), this.path);
    }

    disable() {
        this._dock?.destroy();
        this._dock = null;
        this._settings = null;
    }
}
