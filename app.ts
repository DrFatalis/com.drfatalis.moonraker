'use strict';

import Homey from 'homey';

class Moonraker extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('Moonraker has been initialized');
  }

}

module.exports = Moonraker;
