'use strict';

const Homey = require('homey');
const MoonrakerClient = require('../../lib/MoonrakerClient');

const CORE_OBJECTS = {
  print_stats:    null,
  virtual_sdcard: null,
  extruder:       null,
  heater_bed:     null,
  toolhead:       null,
  webhooks:       null,
  display_status: null,
};

const TEMP_OBJECT_PREFIXES = [
  'temperature_sensor',
  'temperature_fan',
  'bme280',
  'htu21d',
  'lm75',
  'ds18b20',
  'aht10',
  'sht3x',
];

class MoonrakerDevice extends Homey.Device {

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async onInit() {
    this.log('MoonrakerDevice init:', this.getName());

    await this._migrateCapabilities();

    this._client          = null;
    this._reconnectTimer  = null;
    this._reconnectCount  = 0;
    this._extraSensors    = [];

    // Webcam state
    this._webcamVideos  = [];
    this._webcamImages  = [];
    this._webcamTimers  = [];
    this._webcamsInited = false;

    // State tracking
    this._prevStatus      = null;
    this._prevJobName     = null;
    this._printDuration   = 0;
    this._lastJobDuration = 0;
    this._tempAtTarget    = new Map();

    // Completion tracking (integer % — only fire trigger when value changes)
    this._prevCompletionTime  = -1;
    this._prevCompletionLayer = -1;
    this._currentLayer        = 0;
    this._totalLayer          = 0;

    // Previous layer time tracking
    this._layerChangeTime = Date.now();
    this._prevLayerTime   = 0;

    // Guards against double-firing jobFinished when both notify_job_state_changed
    // and a status snapshot deliver the 'complete' state.
    this._jobCompletedFired = false;

    // Chamber sensor tracking (for chamber_temp_changed trigger)
    this._chamberSensors  = new Map();  // objectName → last temp

    this._triggers = {
      jobStarted:             this.homey.flow.getDeviceTriggerCard('job_start'),
      jobFinished:            this.homey.flow.getDeviceTriggerCard('job_complete'),
      jobCancelled:           this.homey.flow.getDeviceTriggerCard('job_cancelled'),
      jobFailed:              this.homey.flow.getDeviceTriggerCard('job_error'),
      jobHold:                this.homey.flow.getDeviceTriggerCard('job_hold'),
      printerError:           this.homey.flow.getDeviceTriggerCard('printer_error'),
      statusChanged:          this.homey.flow.getDeviceTriggerCard('status_changed'),
      tempReached:            this.homey.flow.getDeviceTriggerCard('temperature_reached'),
      chamberTempChanged:     this.homey.flow.getDeviceTriggerCard('chamber_temp_changed'),
      completionTimeChanged:  this.homey.flow.getDeviceTriggerCard('completion_time_changed'),
      completionLayerChanged: this.homey.flow.getDeviceTriggerCard('completion_layer_changed'),
    };

    await this._connect();
  }

  async onSettings({ changedKeys }) {
    if (changedKeys.some(k => ['address', 'port', 'api_key', 'url'].includes(k))) {
      await this._disconnect();
      await this._connect();
    }
  }

  async onDeleted() {
    this.log('MoonrakerDevice deleted');
    await this._disconnect();
  }

  // ─── v1 → v2 capability migration ────────────────────────────────────────────

  async _migrateCapabilities() {
    const obsolete = [
      'printer_state', 'printer_temp_tool', 'printer_temp_bed', 'printer_temp_chamber',
      'job_layer', 'job_pause', 'job_resume', 'job_timeleft', 'previous_layer',
      'measure_temperature.hotend', 'measure_temperature.bed',
    ];
    for (const cap of obsolete) {
      if (this.hasCapability(cap)) {
        this.log(`Migrating: removing obsolete capability "${cap}"`);
        await this.removeCapability(cap).catch(e => this.error(`removeCapability(${cap}):`, e.message));
      }
    }

    const required = [
      'printer_status', 'printer_job_name', 'printer_job_progress',
      'printer_job_eta', 'printer_job_layer',
      'printer_hotend_temperature', 'printer_bed_temperature',
      'printer_hotend_target', 'printer_bed_target',
      'job_completion_layer', 'job_completion_time',
      'job_time', 'current_layer', 'total_layer', 'previous_layer_time',
    ];
    for (const cap of required) {
      if (!this.hasCapability(cap)) {
        this.log(`Migrating: adding missing capability "${cap}"`);
        await this.addCapability(cap).catch(e => this.error(`addCapability(${cap}):`, e.message));
      }
    }

    // Push updated icons to existing devices for capabilities whose icons changed.
    const capOptions = {
      'printer_hotend_target': { icon: '/drivers/printer/assets/printer_temp_tool_target.svg' },
      'printer_bed_target':    { icon: '/drivers/printer/assets/printer_temp_bed_target.svg' },
    };
    for (const [cap, opts] of Object.entries(capOptions)) {
      if (this.hasCapability(cap)) {
        await this.setCapabilityOptions(cap, opts).catch(e =>
          this.error(`setCapabilityOptions(${cap}):`, e.message)
        );
      }
    }
  }

  // ─── Connect / disconnect ────────────────────────────────────────────────────

  async _connect() {
    const s = this.getSettings();

    // Support new settings (address/port) and legacy drfatalis settings (url: "host:port")
    let address = s.address || '';
    let port    = s.port    || 7125;
    if (!address && s.url) {
      const parts = s.url.split(':');
      address = parts[0];
      port    = parts[1] ? parseInt(parts[1], 10) || 7125 : 7125;
    }
    const apiKey = s.api_key || '';

    if (!address) {
      this.setUnavailable('No IP address configured').catch(() => {});
      return;
    }

    this._client = new MoonrakerClient({
      address,
      port,
      apiKey,
      logger:              this,
      onScheduleReconnect: () => this._scheduleReconnect(),
    });

    this._client.on('connected',          () => this._onConnected());
    this._client.on('disconnected',       () => this._onDisconnected());
    this._client.on('error',              (e) => this.error('[ws]', e.message));
    this._client.on('printerObjects',     (o) => this._processStatus(o));
    this._client.on('klippyReady',        () => this._updateStatus('ready'));
    this._client.on('klippyShutdown',     () => {
      this._updateStatus('shutdown');
      this._triggers.printerError.trigger(this, { error_message: 'Klippy entered shutdown state' }).catch(() => {});
    });
    this._client.on('klippyDisconnected', () => this._updateStatus('disconnected'));
    this._client.on('jobStateChanged',    (state, job) => this._onJobStateChanged(state, job));

    this._client.connect();
  }

  async _disconnect() {
    this._cancelReconnect();
    this._cleanupWebcams();
    if (this._client) {
      this._client.destroy();
      this._client = null;
    }
  }

  _scheduleReconnect() {
    this._cancelReconnect();
    this._reconnectCount += 1;
    this.log(`Reconnect attempt #${this._reconnectCount} in 5 s`);
    this._reconnectTimer = this.homey.setTimeout(() => {
      this._reconnectTimer = null;
      if (this._client && !this._client._destroyed) this._client.connect();
    }, 5000);
  }

  _cancelReconnect() {
    if (this._reconnectTimer) {
      this.homey.clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // ─── Connected handler ────────────────────────────────────────────────────────

  async _onConnected() {
    if (this._reconnectCount > 0) {
      this.log(`Reconnected to Moonraker after ${this._reconnectCount} attempt(s)`);
    } else {
      this.log('Connected to Moonraker');
    }
    this._reconnectCount = 0;
    try {
      await this._discoverExtraSensors();
      await this._subscribe();

      if (!this._webcamsInited) {
        this._webcamsInited = true;
        await this._initWebcams();
      }
    } catch (err) {
      this.error('Init error after connect:', err.message);
    }
    // Mark available whenever the WebSocket is up, even if init had a transient error
    if (this._client && !this._client._destroyed) {
      this.setAvailable().catch(() => {});
    }
  }

  _onDisconnected() {
    this.log('Disconnected from Moonraker');
    this.setCapabilityValue('printer_status', 'disconnected').catch(() => {});
    this.setUnavailable('Disconnected from Moonraker').catch(() => {});
  }

  // ─── Dynamic sensor discovery ─────────────────────────────────────────────────

  async _discoverExtraSensors() {
    let allObjects;
    try {
      allObjects = await this._client.listObjects();
    } catch (err) {
      this.error('listObjects failed:', err.message);
      return;
    }

    this.log('Printer objects available:', allObjects);

    const knownExtraCaps = new Set(
      this.getCapabilities().filter(c => c.startsWith('measure_temperature.'))
    );

    const newSensors = [];
    const extraHeaterPattern = /^extruder[1-9]\d*$/;

    for (const objName of allObjects) {
      const isExtraHeater = extraHeaterPattern.test(objName);
      const isTempSensor  = TEMP_OBJECT_PREFIXES.some(p => objName.startsWith(p));
      if (!isTempSensor && !isExtraHeater) continue;

      const safeName = objName.replace(/[^a-z0-9]/gi, '_').toLowerCase().replace(/_+/g, '_').replace(/^_|_$/g, '');
      const capId    = `measure_temperature.${safeName}`;

      const isChamber = objName.toLowerCase().includes('chamber');
      const icon = isChamber
        ? '/drivers/printer/assets/printer_temp_chamber.svg'
        : '/drivers/printer/assets/printer_temp.svg';

      newSensors.push({ objectName: objName, capabilityId: capId, label: this._humanizeLabel(objName), icon });
    }

    for (const sensor of newSensors) {
      try {
        if (!this.hasCapability(sensor.capabilityId)) {
          this.log(`Discovered new sensor: "${sensor.objectName}" → ${sensor.capabilityId}`);
          await this.addCapability(sensor.capabilityId);
        }
        await this.setCapabilityOptions(sensor.capabilityId, {
          title: { en: sensor.label },
          units: { en: '°C' },
          icon:  sensor.icon,
        });
      } catch (err) {
        this.error(`Failed to add/update capability ${sensor.capabilityId}:`, err.message);
      }
    }

    const newCapIds = new Set(newSensors.map(s => s.capabilityId));
    for (const oldCap of knownExtraCaps) {
      if (!newCapIds.has(oldCap)) {
        this.log(`Removing stale sensor capability: ${oldCap}`);
        await this.removeCapability(oldCap).catch(() => {});
      }
    }

    this._extraSensors = newSensors;
  }

  // ─── Webcam support ───────────────────────────────────────────────────────────

  _resolveWebcamUrl(url) {
    if (!url) return null;
    if (url.includes('://')) return url; // already absolute (http, https, rtsp, rtmp, …)
    return `${this._client.baseUrl}${url.startsWith('/') ? '' : '/'}${url}`;
  }

  // If the snapshot URL is a go2rtc /api/frame.jpeg endpoint, derive the HLS .m3u8 URL
  // from the same host — Homey supports HLS natively as a live video stream.
  _deriveGo2rtcHlsUrl(resolvedSnapshotUrl) {
    if (!resolvedSnapshotUrl) return null;
    try {
      const u = new URL(resolvedSnapshotUrl);
      if (u.pathname === '/api/frame.jpeg') {
        const src = u.searchParams.get('src');
        if (src) return `${u.protocol}//${u.host}/api/stream.m3u8?src=${encodeURIComponent(src)}`;
      }
    } catch {}
    return null;
  }

  async _initWebcams() {
    let webcams = [];
    try {
      const data = await this._client.httpGet('/server/webcams/list');
      webcams = data?.result?.webcams || [];
    } catch (err) {
      this.log('Webcam API unavailable (older Moonraker?):', err.message);
      return;
    }

    const enabled = webcams.filter(w => w.enabled !== false);
    if (!enabled.length) {
      this.log('No enabled webcams found in Moonraker');
      return;
    }

    this.log(`Found ${enabled.length} webcam(s)`);

    for (let i = 0; i < enabled.length; i++) {
      const cam = enabled[i];
      const id    = `webcam_${i}`;
      const title = cam.name || `Webcam ${i + 1}`;

      if (cam.service === 'hlsstream' && cam.stream_url) {
        // Native HLS stream declared in Moonraker config
        await this._setupWebcamVideo(id, title, cam.stream_url);
      } else {
        // For other service types, check if go2rtc is backing the snapshot endpoint.
        // go2rtc serves snapshots at /api/frame.jpeg?src=NAME and HLS at /api/stream.m3u8?src=NAME.
        // Homey supports HLS natively (createVideoHLS), so we can show a true live stream
        // even when Moonraker reports the service type as mjpegstreamer-adaptive or similar.
        const resolvedSnapshot = cam.snapshot_url ? this._resolveWebcamUrl(cam.snapshot_url) : null;
        const go2rtcHls = this._deriveGo2rtcHlsUrl(resolvedSnapshot);

        if (go2rtcHls) {
          this.log(`Webcam "${title}": go2rtc detected, using HLS → ${go2rtcHls}`);
          await this._setupWebcamVideo(id, title, go2rtcHls);
        } else if (cam.stream_url && cam.stream_url.startsWith('rtsp://')) {
          // Direct RTSP stream (e.g. IP cameras, ipstream service)
          await this._setupWebcamRtsp(id, title, cam.stream_url);
        } else if (cam.snapshot_url) {
          // Plain snapshot camera — show refreshing still image
          await this._setupWebcamSnapshot(id, title, cam.snapshot_url);
        } else {
          this.log(`Webcam "${title}" (${cam.service}): no supported stream or snapshot URL, skipping`);
        }
      }
    }
  }

  async _setupWebcamVideo(id, title, streamUrl) {
    try {
      const url = this._resolveWebcamUrl(streamUrl);
      const video = await this.homey.videos.createVideoHLS();
      video.registerVideoUrlListener(async () => ({ url }));
      await this.setCameraVideo(id, title, video);
      this._webcamVideos.push(video);
      this.log(`Webcam HLS video registered: "${title}" → ${url}`);
    } catch (err) {
      this.error(`Failed to register webcam video "${title}":`, err.message);
    }
  }

  async _setupWebcamRtsp(id, title, streamUrl) {
    try {
      const url = this._resolveWebcamUrl(streamUrl);
      const video = await this.homey.videos.createVideoRTSP();
      video.registerVideoUrlListener(async () => ({ url }));
      await this.setCameraVideo(id, title, video);
      this._webcamVideos.push(video);
      this.log(`Webcam RTSP video registered: "${title}" → ${url}`);
    } catch (err) {
      this.error(`Failed to register webcam RTSP video "${title}":`, err.message);
    }
  }

  async _setupWebcamSnapshot(id, title, snapshotUrl) {
    try {
      const url = this._resolveWebcamUrl(snapshotUrl);
      const img = await this.homey.images.createImage();
      img.setStream(async (imageStream) => {
        try {
          const headers = {};
          const apiKey = this.getSettings().api_key;
          if (apiKey) headers['X-Api-Key'] = apiKey;
          const res = await fetch(url, { headers });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          imageStream.end(Buffer.from(await res.arrayBuffer()));
        } catch (err) {
          this.error(`Webcam snapshot fetch failed (${url}):`, err.message);
          imageStream.end();
        }
      });
      await this.setCameraImage(id, title, img);
      this._webcamImages.push(img);

      // Periodically refresh the snapshot so the device card shows a live still
      const timer = this.homey.setInterval(() => img.update().catch(() => {}), 5000);
      this._webcamTimers.push(timer);
      this.log(`Webcam snapshot registered: "${title}" → ${url} (refresh 5 s)`);
    } catch (err) {
      this.error(`Failed to register webcam snapshot "${title}":`, err.message);
    }
  }

  _cleanupWebcams() {
    for (const t of this._webcamTimers) this.homey.clearInterval(t);
    this._webcamTimers = [];

    for (const v of this._webcamVideos) v.unregister().catch(() => {});
    this._webcamVideos = [];

    this._webcamImages  = [];
    this._webcamsInited = false;
  }

  // ─── Dynamic sensor discovery ─────────────────────────────────────────────────

  _humanizeLabel(objectName) {
    const skipWords = new Set(['temperature', 'temp', 'sensor', 'fan']);
    const words = objectName
      .split(/[\s_]+/)
      .filter(w => !skipWords.has(w.toLowerCase()))
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
    return words.length ? `${words.join(' ')} Temp` : objectName;
  }

  // ─── Subscription ─────────────────────────────────────────────────────────────

  async _subscribe() {
    const objects = { ...CORE_OBJECTS };
    for (const s of this._extraSensors) objects[s.objectName] = null;
    if (this._client) {
      const allObjects = await this._client.listObjects().catch(() => []);
      for (const o of allObjects) {
        if (/^extruder[1-9]\d*$/.test(o)) objects[o] = null;
      }
    }
    this.log('Subscribing to:', Object.keys(objects).join(', '));
    const snap = await this._client.subscribe(objects);
    if (snap?.status) {
      this.log('Processing subscription snapshot');
      this._processStatus(snap.status);
    }
  }

  // ─── Status processing ────────────────────────────────────────────────────────

  _processStatus(status) {
    try {
      // If Klippy isn't ready, sensor values are zero-initialized defaults — skip
      // temperature updates to preserve the last known good values in Homey.
      // Print state is still processed so status/job tiles reflect the real state.
      const klippyReady = status.webhooks === undefined || status.webhooks.state === 'ready';

      // ── extruder ──
      if (klippyReady && status.extruder !== undefined) {
        const { temperature, target } = status.extruder;
        if (temperature !== undefined) this._setCap('printer_hotend_temperature', this._round1(temperature));
        if (target      !== undefined) {
          this._setCap('printer_hotend_target', this._round1(target));
          this._checkTempReached('printer_hotend_temperature', 'Hotend', temperature, target);
        }
      }

      // ── heater_bed ──
      if (klippyReady && status.heater_bed !== undefined) {
        const { temperature, target } = status.heater_bed;
        if (temperature !== undefined) this._setCap('printer_bed_temperature', this._round1(temperature));
        if (target      !== undefined) {
          this._setCap('printer_bed_target', this._round1(target));
          this._checkTempReached('printer_bed_temperature', 'Bed', temperature, target);
        }
      }

      // ── extra sensors (including chamber) ──
      if (klippyReady) {
        for (const sensor of this._extraSensors) {
          const data = status[sensor.objectName];
          if (!data) continue;
          if (data.temperature !== undefined) {
            this._setCap(sensor.capabilityId, this._round1(data.temperature));
          }
          if (data.target !== undefined) {
            this._checkTempReached(sensor.capabilityId, sensor.label, data.temperature, data.target);
          }
          if (sensor.objectName.toLowerCase().includes('chamber') && data.temperature !== undefined) {
            this._checkChamberChanged(sensor.objectName, data.temperature, data.target);
          }
        }
      }

      // ── print_stats ──
      if (status.print_stats !== undefined) {
        const { state, filename, print_duration, total_duration, message } = status.print_stats;

        if (filename !== undefined) {
          this._setCap('printer_job_name', filename ? filename.replace(/\.gcode$/i, '') : '');
        }
        if (print_duration !== undefined) {
          this._printDuration = print_duration;
          this._setCap('job_time', Math.round(print_duration / 60));
        }
        if (total_duration !== undefined) {
          this._lastJobDuration = Math.round(total_duration / 60);
        }
        if (state !== undefined) {
          this._updateStatus(state, message);
        }

        // Layer info from Klipper's print_stats.info (populated by SET_PRINT_STATS_INFO macro)
        const info = status.print_stats.info;
        if (info) {
          if (info.current_layer != null) {
            const newLayer = info.current_layer;
            if (newLayer !== this._currentLayer) {
              this._prevLayerTime   = Math.round((Date.now() - this._layerChangeTime) / 1000);
              this._layerChangeTime = Date.now();
              this._currentLayer    = newLayer;
              this._setCap('previous_layer_time', this._prevLayerTime);
            }
          }
          if (info.total_layer != null) this._totalLayer = info.total_layer;

          this._setCap('current_layer', this._currentLayer);
          this._setCap('total_layer',   this._totalLayer);
          const layerPct = this._totalLayer > 0
            ? Math.round(this._currentLayer * 100 / this._totalLayer)
            : 0;
          this._setCap('job_completion_layer', layerPct);
          this._checkCompletionLayer();

          // Keep the visible layer string in sync: "current / total" when total is known
          if (this._totalLayer > 0) {
            this._setCap('printer_job_layer', `${this._currentLayer} / ${this._totalLayer}`);
          } else if (this._currentLayer > 0) {
            this._setCap('printer_job_layer', String(this._currentLayer));
          }
        }
      }

      // ── virtual_sdcard ──
      if (status.virtual_sdcard !== undefined) {
        const { progress } = status.virtual_sdcard;
        if (progress !== undefined) {
          this._setCap('printer_job_progress', this._round1(progress * 100));
          this._setCap('job_completion_time',  Math.round(progress * 100));
          this._checkCompletionTime(progress);
          this._updateEta(progress);
        }
      }

      // ── display_status (layer string fallback when print_stats.info has no data) ──
      if (status.display_status !== undefined && this._totalLayer === 0) {
        const { message } = status.display_status;
        if (message) {
          const m = message.match(/layer\s*(\d+)\s*(?:\/\s*(\d+))?/i);
          if (m) this._setCap('printer_job_layer', m[2] ? `${m[1]} / ${m[2]}` : m[1]);
        }
      }

    } catch (err) {
      this.error('_processStatus error:', err.message);
    }
  }

  // ─── ETA ──────────────────────────────────────────────────────────────────────

  _updateEta(progressFraction) {
    if (!progressFraction || progressFraction <= 0 || progressFraction >= 1 ||
        !this._printDuration || this._prevStatus !== 'printing') {
      this._setCap('printer_job_eta', 0);
      return;
    }
    const estimatedTotal   = this._printDuration / progressFraction;
    const remainingSeconds = Math.max(0, estimatedTotal - this._printDuration);
    this._setCap('printer_job_eta', Math.round(remainingSeconds / 60));
  }

  // ─── Status ───────────────────────────────────────────────────────────────────

  _updateStatus(rawState, message) {
    const state = this._normalizeState(rawState);
    const prev  = this._prevStatus;

    this._setCap('printer_status', state);

    if (state !== prev) {
      this._prevStatus = state;

      if (prev !== null) {
        this._triggers.statusChanged.trigger(this, {
          status:          state,
          previous_status: prev || 'unknown',
        }).catch(() => {});

        if (state === 'paused') {
          this._triggers.jobHold.trigger(this).catch(() => {});
        }

        // Fallback: fire jobFinished if notify_job_state_changed was missed
        // (e.g. the job completed while the WebSocket connection was down).
        if (state === 'complete' && !this._jobCompletedFired) {
          const jobName = this.getCapabilityValue('printer_job_name') || 'unknown';
          this._triggers.jobFinished.trigger(this, {
            job_name: jobName,
            duration: this._lastJobDuration,
          }).catch(() => {});
        }
        if (state === 'printing') this._jobCompletedFired = false;
      }

      if (state === 'error' && message) {
        this._triggers.printerError.trigger(this, { error_message: message }).catch(() => {});
      }

      if (['standby', 'complete', 'cancelled', 'error'].includes(state)) {
        this._setCap('printer_job_eta', 0);
        this._prevCompletionTime  = -1;
        this._prevCompletionLayer = -1;
        this._currentLayer        = 0;
        this._totalLayer          = 0;
        this._layerChangeTime     = Date.now();
        if (['standby', 'complete', 'cancelled'].includes(state)) {
          this._setCap('printer_job_progress', 0);
        }
      }
    }
  }

  _normalizeState(state) {
    const map = {
      standby:             'standby',
      printing:            'printing',
      paused:              'paused',
      complete:            'complete',
      error:               'error',
      cancelled:           'cancelled',
      ready:               'ready',
      startup:             'startup',
      shutdown:            'shutdown',
      klippy_disconnected: 'disconnected',
      disconnected:        'disconnected',
    };
    return map[(state || '').toLowerCase()] || (state || 'unknown').toLowerCase();
  }

  // ─── Completion tracking ──────────────────────────────────────────────────────

  _checkCompletionTime(progressFraction) {
    if (this._prevStatus !== 'printing') return;
    const pct = Math.round(progressFraction * 100);
    if (pct === this._prevCompletionTime) return;
    this._prevCompletionTime = pct;
    this._triggers.completionTimeChanged.trigger(this, { 'Completion time %': pct }).catch(() => {});
  }

  _checkCompletionLayer() {
    if (this._prevStatus !== 'printing') return;
    if (!this._totalLayer || this._totalLayer <= 0) return;
    const pct = Math.round(this._currentLayer * 100 / this._totalLayer);
    if (pct === this._prevCompletionLayer) return;
    this._prevCompletionLayer = pct;
    this._triggers.completionLayerChanged.trigger(this, { 'Completion layer %': pct }).catch(() => {});
  }

  // ─── Temperature reached ─────────────────────────────────────────────────────

  _checkTempReached(capId, sensorName, currentTemp, targetTemp) {
    if (currentTemp === undefined || targetTemp === undefined || targetTemp <= 0) {
      this._tempAtTarget.set(capId, false);
      return;
    }
    const atTarget    = Math.abs(currentTemp - targetTemp) <= 2.0;
    const wasAtTarget = this._tempAtTarget.get(capId) || false;
    if (atTarget && !wasAtTarget) {
      this._triggers.tempReached.trigger(this, {
        sensor_name: sensorName,
        temperature: this._round1(currentTemp),
      }).catch(() => {});
    }
    this._tempAtTarget.set(capId, atTarget);
  }

  // ─── Chamber temp changed ────────────────────────────────────────────────────

  _checkChamberChanged(objectName, temperature, target) {
    const prev = this._chamberSensors.get(objectName);
    if (prev === temperature) return;
    this._chamberSensors.set(objectName, temperature);
    this._triggers.chamberTempChanged.trigger(this, {
      'Chamber temperature': temperature != null ? this._round1(temperature) : 0,
      'Chamber target':      target      != null ? this._round1(target)      : 0,
    }).catch(() => {});
  }

  // ─── Job state (from notify_job_state_changed) ────────────────────────────────

  _onJobStateChanged(stateName, job) {
    this.log(`Job state: ${stateName} — file: ${job?.filename || '?'}`);

    const jobName = job?.filename
      ? job.filename.replace(/\.gcode$/i, '')
      : (this.getCapabilityValue('printer_job_name') || 'unknown');

    switch (stateName) {
      case 'printing':
        this._jobCompletedFired = false;
        if (jobName !== this._prevJobName) {
          this._prevJobName     = jobName;
          this._layerChangeTime = Date.now();
          this._triggers.jobStarted.trigger(this, { job_name: jobName }).catch(() => {});
        }
        break;

      case 'complete':
        this._jobCompletedFired = true;
        this._triggers.jobFinished.trigger(this, {
          job_name: jobName,
          duration: this._lastJobDuration,
        }).catch(() => {});
        this._prevJobName = null;
        break;

      case 'cancelled':
        this._triggers.jobCancelled.trigger(this, { job_name: jobName }).catch(() => {});
        this._prevJobName = null;
        break;

      case 'error':
        this._triggers.jobFailed.trigger(this, {
          job_name: jobName,
          error:    job?.message || 'Unknown error',
        }).catch(() => {});
        this._prevJobName = null;
        break;

      default:
        break;
    }
  }

  // ─── Printer control (Flow actions) ──────────────────────────────────────────

  async pauseJob() {
    this.log('pauseJob');
    await this._client.httpPost('/printer/print/pause');
  }

  async resumeJob() {
    this.log('resumeJob');
    await this._client.httpPost('/printer/print/resume');
  }

  async cancelJob() {
    this.log('cancelJob');
    await this._client.httpPost('/printer/print/cancel');
  }

  async emergencyStop() {
    this.log('emergencyStop');
    await this._client.httpPost('/printer/emergency_stop');
  }

  async sendGcode(gcode) {
    const script = (gcode || '').trim();
    if (!script) throw new Error('GCode is empty');
    this.log('sendGcode:', script);
    await this._client.httpPost('/printer/gcode/script', { script });
  }

  // ─── Utilities ────────────────────────────────────────────────────────────────

  _setCap(id, value) {
    if (!this.hasCapability(id)) return;
    this.setCapabilityValue(id, value).catch(err =>
      this.error(`setCapabilityValue(${id}=${value}):`, err.message)
    );
  }

  _round1(n) {
    return Math.round(n * 10) / 10;
  }

}

module.exports = MoonrakerDevice;
