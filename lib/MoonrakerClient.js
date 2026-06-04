'use strict';

const { EventEmitter } = require('events');

// Node 22 has native WebSocket; fallback to ws package
const WS = (() => {
  if (typeof globalThis.WebSocket !== 'undefined') return globalThis.WebSocket;
  try { return require('ws'); } catch { return null; }
})();

const PING_INTERVAL_MS   = 25000;
const REQUEST_TIMEOUT_MS = 10000;

/**
 * MoonrakerClient
 *
 * Manages a persistent WebSocket connection to a Moonraker instance.
 * Reconnection is delegated to a caller-supplied `onScheduleReconnect` callback
 * so that Homey's timer system can be used by the Device layer.
 *
 * Emits:
 *   'connected'
 *   'disconnected'
 *   'error'            (Error)
 *   'printerObjects'   (statusObj)         – notify_status_update
 *   'klippyReady'
 *   'klippyShutdown'
 *   'klippyDisconnected'
 *   'jobStateChanged'  (stateName, job)    – notify_job_state_changed
 *   'gcodeResponse'    (message)
 */
class MoonrakerClient extends EventEmitter {

  /**
   * @param {object}   opts
   * @param {string}   opts.address
   * @param {number}   [opts.port=7125]
   * @param {string}   [opts.apiKey='']
   * @param {object}   [opts.logger=console]
   * @param {Function} opts.onScheduleReconnect  - called when a reconnect is needed
   */
  constructor({ address, port = 7125, apiKey = '', logger = console, onScheduleReconnect }) {
    super();
    this._address   = address;
    this._port      = port;
    this._apiKey    = apiKey;
    this._log       = logger;
    this._scheduleReconnect = onScheduleReconnect || (() => {});

    this._ws        = null;
    this._connected = false;
    this._destroyed = false;
    this._msgId     = 1;
    this._pending   = new Map();
    this._pingTimer = null;

    // Saved subscription to restore after reconnect
    this._lastSubscription = null;
  }

  // ─── Public ──────────────────────────────────────────────────────────────────

  get baseUrl() {
    return `http://${this._address}:${this._port}`;
  }

  connect() {
    if (!this._destroyed) this._openSocket();
  }

  destroy() {
    this._destroyed = true;
    this._stopPing();
    this._closeSocket();
    this._rejectAll(new Error('Client destroyed'));
    this.removeAllListeners();
  }

  // ─── JSON-RPC ────────────────────────────────────────────────────────────────

  request(method, params) {
    return new Promise((resolve, reject) => {
      if (!this._connected) {
        return reject(new Error(`Not connected (${method})`));
      }

      const id  = this._msgId++;
      const msg = { jsonrpc: '2.0', method, id };
      if (params !== undefined) msg.params = params;

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout: ${method}`));
      }, REQUEST_TIMEOUT_MS);

      this._pending.set(id, { resolve, reject, timer });

      try {
        const payload = JSON.stringify(msg);
        // ws module uses send(data, callback); native WebSocket uses send(data)
        if (this._ws.send.length >= 2) {
          this._ws.send(payload, (err) => {
            if (err) {
              clearTimeout(timer);
              this._pending.delete(id);
              reject(err);
            }
          });
        } else {
          this._ws.send(payload);
        }
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  // ─── HTTP ────────────────────────────────────────────────────────────────────

  async httpGet(path) {
    const headers = {};
    if (this._apiKey) headers['X-Api-Key'] = this._apiKey;
    const res = await fetch(`${this.baseUrl}${path}`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} GET ${path}`);
    return res.json();
  }

  async httpPost(path, body) {
    const headers = {};
    if (this._apiKey) headers['X-Api-Key'] = this._apiKey;
    if (body) headers['Content-Type'] = 'application/json';
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} POST ${path}`);
    return res.json();
  }

  // ─── Moonraker helpers ───────────────────────────────────────────────────────

  async testConnection() {
    const data = await this.httpGet('/server/info');
    return data.result || data;
  }

  async listObjects() {
    const res = await this.request('printer.objects.list');
    return (res && res.objects) ? res.objects : [];
  }

  async queryObjects(objects) {
    return this.request('printer.objects.query', { objects });
  }

  async subscribe(objects) {
    this._lastSubscription = objects;
    if (this._connected) {
      return this.request('printer.objects.subscribe', { objects });
    }
  }

  // ─── WebSocket lifecycle ─────────────────────────────────────────────────────

  _openSocket() {
    if (!WS) {
      this.emit('error', new Error('No WebSocket implementation available. Run: npm install ws'));
      return;
    }

    // Detach handlers from any lingering socket before creating a new one, so
    // late async events from the old socket don't interfere with the new one.
    this._detachSocket();

    const url = `ws://${this._address}:${this._port}/websocket${this._apiKey ? `?token=${this._apiKey}` : ''}`;
    this._log.log(`[MoonrakerClient] Connecting → ${url}`);

    try {
      this._ws = new WS(url);
    } catch (err) {
      this._log.error('[MoonrakerClient] Socket create error:', err.message);
      this._scheduleReconnect();
      return;
    }

    // Support both ws-module style (on) and native EventTarget style (addEventListener)
    if (typeof this._ws.on === 'function') {
      this._ws.on('open',    ()     => this._onOpen());
      this._ws.on('close',   ()     => this._onClose());
      this._ws.on('error',   (err)  => this._onError(err));
      this._ws.on('message', (data) => this._onMessage(data));
    } else {
      this._ws.onopen    = ()    => this._onOpen();
      this._ws.onclose   = ()    => this._onClose();
      this._ws.onerror   = (ev)  => this._onError(new Error(ev.message || 'ws error'));
      this._ws.onmessage = (ev)  => this._onMessage(ev.data);
    }
  }

  _detachSocket() {
    if (!this._ws) return;
    if (typeof this._ws.removeAllListeners === 'function') {
      this._ws.removeAllListeners();
    } else {
      this._ws.onopen = this._ws.onclose = this._ws.onerror = this._ws.onmessage = null;
    }
  }

  _closeSocket() {
    if (this._ws) {
      this._detachSocket();
      try { this._ws.close(); } catch {}
      this._ws = null;
    }
  }

  _onOpen() {
    this._log.log('[MoonrakerClient] WebSocket open');
    this._connected = true;
    this._startPing();

    this.request('server.connection.identify', {
      client_name: 'HomeyMoonraker',
      version:     '1.0.0',
      type:        'other',
      url:         'https://homey.app',
    }).catch(() => {});

    if (this._lastSubscription) {
      this.request('printer.objects.subscribe', { objects: this._lastSubscription })
        .catch(err => this._log.error('[MoonrakerClient] Re-subscribe error:', err.message));
    }

    this.emit('connected');
  }

  _onClose() {
    const was = this._connected;
    this._connected = false;
    this._stopPing();
    this._rejectAll(new Error('WebSocket closed'));
    if (!this._destroyed) this._scheduleReconnect();
    if (was) this.emit('disconnected');
  }

  _onError(err) {
    this._log.error('[MoonrakerClient] Socket error:', err.message);
    this.emit('error', err);
    // 'close' event will follow and trigger reconnect
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    } catch { return; }

    if (msg.id !== undefined) {
      const p = this._pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        this._pending.delete(msg.id);
        msg.error
          ? p.reject(new Error(msg.error.message || JSON.stringify(msg.error)))
          : p.resolve(msg.result);
      }
      return;
    }

    if (msg.method) this._handleNotification(msg.method, msg.params);
  }

  _handleNotification(method, params) {
    const first = Array.isArray(params) ? params[0] : params;
    switch (method) {
      case 'notify_status_update':      this.emit('printerObjects',  first);                                  break;
      case 'notify_klippy_ready':       this.emit('klippyReady');                                             break;
      case 'notify_klippy_shutdown':    this.emit('klippyShutdown');                                          break;
      case 'notify_klippy_disconnected':this.emit('klippyDisconnected');                                      break;
      case 'notify_job_state_changed':  this.emit('jobStateChanged', first?.state_name, first?.job);          break;
      case 'notify_gcode_response':     this.emit('gcodeResponse',   first);                                  break;
      default: break;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._connected) this.request('server.info').catch(() => {});
    }, PING_INTERVAL_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();
  }

  _stopPing() {
    if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
  }

  _rejectAll(err) {
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }
}

module.exports = MoonrakerClient;
