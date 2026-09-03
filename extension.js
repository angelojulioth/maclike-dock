import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class MaclikeDockExtension extends Extension {
    async enable() {
        this._settings = this.getSettings();
        const enableGen = (this._generation = (this._generation || 0) + 1);
        try {
            const {MaclikeDock} = await import(`./dock.js?t=${Date.now()}`);
            if (this._generation !== enableGen)
                return;
            this._dock = new MaclikeDock(this._settings, this.getLogger(), this.path);
        } catch (error) {
            console.error('[MaclikeDock] Error enabling extension:', error);
        }
    }

    disable() {
        this._generation = (this._generation || 0) + 1;
        this._dock?.destroy();
        this._dock = null;
        this._settings = null;
    }
}
