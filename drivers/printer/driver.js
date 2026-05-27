'use strict';

const Homey = require('homey');
const MoonrakerClient = require('../../lib/MoonrakerClient');

class MoonrakerDriver extends Homey.Driver {

  async onInit() {
    this.log('MoonrakerDriver ready');
  }

  async onPair(session) {
    let pairData = {
      address:          '',
      port:             7125,
      apiKey:           '',
      hostname:         '',
      moonrakerVersion: '',
    };

    session.setHandler('connect', async ({ address, port, apiKey }) => {
      this.log(`Pair: testing ${address}:${port}`);

      let client;
      try {
        client = new MoonrakerClient({
          address,
          port:    parseInt(port, 10) || 7125,
          apiKey:  apiKey || '',
          logger:  this,
          onScheduleReconnect: () => {},
        });

        const info = await client.testConnection();

        pairData = {
          address,
          port:             parseInt(port, 10) || 7125,
          apiKey:           apiKey || '',
          hostname:         info.hostname || address,
          moonrakerVersion: info.moonraker_version || 'unknown',
        };

        this.log(`Pair success: hostname=${pairData.hostname}, moonraker=${pairData.moonrakerVersion}`);
        return { success: true };

      } catch (err) {
        this.error('Pair test failed:', err.message);
        return { success: false, error: `Cannot connect to ${address}:${port} — ${err.message}` };

      } finally {
        if (client) client.destroy();
      }
    });

    session.setHandler('list_devices', async () => {
      const { address, port, apiKey, hostname, moonrakerVersion } = pairData;
      if (!address) return [];
      return [
        {
          name: `3D Printer — ${hostname}`,
          data: {
            id: `moonraker_${address.replace(/\./g, '_')}_${port}`,
          },
          settings: {
            address,
            port,
            api_key:       apiKey,
            poll_interval: 10,
          },
          store: {
            moonrakerVersion,
          },
        },
      ];
    });
  }

}

module.exports = MoonrakerDriver;
