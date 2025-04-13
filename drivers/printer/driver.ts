import Homey, { FlowCard, FlowCardTrigger } from 'homey';
import axios from 'axios';
import { PairSession } from 'homey/lib/Driver';

class PrinterDriver extends Homey.Driver {

  /**
   * onInit is called when the driver is initialized.
   */
  async onInit() {
    this.log('Printer initializing');

    this.homey.flow.getConditionCard('is_standby')
    .registerRunListener(async (args, state) => args.device.checkPrinterIsStandby());

    this.homey.flow.getConditionCard('is_printing')
    .registerRunListener(async (args, state) => args.device.checkPrinterIsPrinting());

    this.homey.flow.getConditionCard('is_paused')
    .registerRunListener(async (args, state) => args.device.checkPrinterIsPaused());

    this.homey.flow.getConditionCard('is_cancelled')
    .registerRunListener(async (args, state) => args.device.checkPrinterIsCancelled());

    this.homey.flow.getConditionCard('is_in_error')
    .registerRunListener(async (args, state) => args.device.checkPrinterIsInError());

    this.log('Printer has been initialized');
  }

  /**
   * onPairListDevices is called when a user is adding a device and the 'list_devices' view is called.
   * This should return an array with the data of devices that are available for pairing.
   */
  async onPair(session: PairSession) {
    // Show a specific view by ID
    await session.showView("printer_settings");

    // Show the next view
    await session.nextView();

    // Show the previous view
    await session.prevView();

    // Close the pair session
    //await session.done();

    // Received when a view has changed
    session.setHandler("printer_settings", async function (viewId) {
      console.log("View: " + viewId);
    });
  }

  async onRepair(session: PairSession) {
    // Show a specific view by ID
    await session.showView("printer_settings");

    // Show the next view
    await session.nextView();

    // Show the previous view
    await session.prevView();

    // Close the pair session
    //await session.done();

    // Received when a view has changed
    session.setHandler("showView", async function (viewId) {
      console.log("View: " + viewId);
    });
  }
}

module.exports = PrinterDriver;
