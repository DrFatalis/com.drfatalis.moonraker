'use strict';

const Homey = require('homey');

class MoonrakerApp extends Homey.App {

  async onInit() {
    this.log('Moonraker App starting...');
    this._registerFlowActions();
    this._registerFlowConditions();
    this.log('Moonraker App started successfully');
  }

  _registerFlowActions() {
    this.homey.flow.getActionCard('pause_job')
      .registerRunListener(async ({ device }) => device.pauseJob());

    this.homey.flow.getActionCard('resume_job')
      .registerRunListener(async ({ device }) => device.resumeJob());

    this.homey.flow.getActionCard('cancel_job')
      .registerRunListener(async ({ device }) => device.cancelJob());

    this.homey.flow.getActionCard('emergency_stop')
      .registerRunListener(async ({ device }) => device.emergencyStop());

    this.homey.flow.getActionCard('send_gcode')
      .registerRunListener(async ({ device, gcode }) => device.sendGcode(gcode));
  }

  _registerFlowConditions() {
    this.homey.flow.getConditionCard('is_printing')
      .registerRunListener(async ({ device }) =>
        device.getCapabilityValue('printer_status') === 'printing'
      );

    this.homey.flow.getConditionCard('is_standby')
      .registerRunListener(async ({ device }) => {
        const s = device.getCapabilityValue('printer_status');
        return s === 'standby' || s === 'ready';
      });

    this.homey.flow.getConditionCard('is_paused')
      .registerRunListener(async ({ device }) =>
        device.getCapabilityValue('printer_status') === 'paused'
      );

    this.homey.flow.getConditionCard('is_in_error')
      .registerRunListener(async ({ device }) =>
        device.getCapabilityValue('printer_status') === 'error'
      );

    this.homey.flow.getConditionCard('is_cancelled')
      .registerRunListener(async ({ device }) =>
        device.getCapabilityValue('printer_status') === 'cancelled'
      );

    this.homey.flow.getConditionCard('job_progress_above')
      .registerRunListener(async ({ device, progress }) => {
        const current = device.getCapabilityValue('printer_job_progress') || 0;
        return current > progress;
      });
  }

}

module.exports = MoonrakerApp;
