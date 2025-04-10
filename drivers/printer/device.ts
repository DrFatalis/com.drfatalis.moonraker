import Homey, { Device } from 'homey';
import axios from 'axios';
import https from 'https';
import { Data_Keys } from '../../utils/data_keys';
const delay = (ms: number | undefined) => new Promise(resolve => setTimeout(resolve, ms));

class PrinterDevice extends Homey.Device {

  refreshingInfo: boolean = false;
  axiosInstance: axios.AxiosInstance =  axios.create({
                                            httpsAgent: new https.Agent({  
                                                rejectUnauthorized: false
                                            })
                                        });
  deviceSettings: any;
  printer: any;

  /**
   * onInit is called when the device is initialized.
   */
  async onInit() {
    this.deviceSettings = this.getSettings();
    //this.log(this.deviceSettings);

    this.log('Device ' + this.deviceSettings.name + ' initializing');

    this.printer = {
      server: null,
      state: {
        cur: Data_Keys.stateInit
      },
      temp: {
        bed: {
          actual: 0,
          target: 0
        },
        hotend: {
          actual: 0,
          target: 0
        },
        chamber: {
          actual: 0,
          target: 0
        }
      },
      job: {
        filename: "",
        total_layer: 0,
        current_layer: 0,
        completion_layer: 0,
        estimate: 0,
        time: 0,
        left: 0,
        completion_time: 0
      },
      memory: {
        firstInit: true,
        completion_layer: 0,
        completion_time: 0,
      }
    };

    this.updateDeviceCapabilities();

    this.log('Device ' + this.deviceSettings.name + ' has been initialized');

    this.registerCapabilityListener("job_completion_layer", this.setCompletionLayerValue.bind(this));
    this.registerCapabilityListener("job_completion_time", this.setCompletionTimeValue.bind(this));
    this.registerCapabilityListener("job_start", this.setJobStart.bind(this));
    this.registerCapabilityListener("job_hold", this.setJobHold.bind(this));
    this.registerCapabilityListener("job_complete", this.setJobComplete.bind(this));

    this.log('Listeners created for device ' + this.deviceSettings.name);

    this.refreshingInfo = true;
    this.addListener('poll', this.refreshInfo);
    this.emit('poll');

  }

  /**
   * onAdded is called when the user adds the device, called just after pairing.
   */
  async onAdded() {
    this.log(this.getSettings().name + ' has been added');
  }

  /**
   * onSettings is called when the user updates the device's settings.
   * @param {object} event the onSettings event data
   * @param {object} event.oldSettings The old settings object
   * @param {object} event.newSettings The new settings object
   * @param {string[]} event.changedKeys An array of keys changed since the previous version
   * @returns {Promise<string|void>} return a custom message that will be displayed
   */
  async onSettings({
    oldSettings,
    newSettings,
    changedKeys,
  }: {
    oldSettings: { [key: string]: boolean | string | number | undefined | null };
    newSettings: { [key: string]: boolean | string | number | undefined | null };
    changedKeys: string[];
  }): Promise<string | void> {
    this.log(this.getSettings().name + ' settings where changed');
    this.updateDeviceCapabilities();
  }

  /**
   * onRenamed is called when the user updates the device's name.
   * This method can be used this to synchronise the name to the device.
   * @param {string} name The new name
   */
  async onRenamed(name: string) {
    this.log(this.getSettings().name + ' was renamed');
  }

  /**
   * onDeleted is called when the user deleted the device.
   */
  async onDeleted() {
    this.log(this.getSettings().name + ' has been deleted');
    this.refreshingInfo = false;
  }

  updateDeviceCapabilities() {
    if(this.getSettings().hasChamberTempSensor) {
      if(this.getCapabilities().find(x => x == "printer_temp_chamber") == null)
      {
        this.addCapability("printer_temp_chamber");
      }
    }
    else {
      if(this.getCapabilities().find(x => x == "printer_temp_chamber") != null)
        {
          this.removeCapability('printer_temp_chamber');
        }
    }
  }

  async getServerUrl(){
    const settings = this.getSettings();
    return settings.url;
  }

  async checkPrinterIsStandby() {
    return (this.printer.state.cur == Data_Keys.stateStandby) ? true : false;
  }

  async checkPrinterIsPrinting() {
    return (this.printer.state.cur == Data_Keys.statePrinting) ? true : false;
  }

  async checkPrinterIsPaused() {
    return (this.printer.state.cur == Data_Keys.statePaused) ? true : false;
  }

  async getPrintTime() {
    return this.printer.job.print_time;
  }

  async getPrintTimeLeft() {
    return this.printer.job.print_time_left;
  }

  async setJobStart(){
    this.log("Job started");
    this.log("---------------------------------------------------------");
  }

  async setJobHold(){
    this.log("Job hold");
  }

  async setJobComplete(){
    this.log("Job complete");
  }

  async setCompletionLayerValue(){
    this.setCapabilityValue('job_completion_layer', this.printer.job.completion_layer).catch(error => this.log(error));
  }

  async setCompletionTimeValue(){
    this.setCapabilityValue('job_completion_time', this.printer.job.completion_time).catch(error => this.log(error)); 
  };

  updateCapabilities(){

    if (this.printer.memory.firstInit){
      this.log("First init done");
      this.printer.memory.firstInit = false;
    }
    else {
      if(this.printer.memory.state != this.printer.state.cur ){
        this.printer.memory.state = this.printer.state.cur;
        switch (this.printer.state.cur) {
         case Data_Keys.statePrinting:
            this.homey.flow.getTriggerCard('job_start').trigger();
            this.setJobStart();     
          case Data_Keys.statePaused:
            this.homey.flow.getTriggerCard('job_hold').trigger();
            this.setJobHold(); 
          case Data_Keys.stateComplete:
          case Data_Keys.stateStandby:
            this.homey.flow.getTriggerCard('job_complete').trigger();
            this.setJobComplete(); 
        }
      }

      if(this.printer.memory.completion_layer != this.printer.job.completion_layer ){
        this.printer.memory.completion_layer = this.printer.job.completion_layer;
        this.homey.flow.getTriggerCard('completion_layer_changed').trigger( 
            { 
              'Completion layer %': this.printer.job.completion_layer != null ? this.printer.job.completion_layer : 0,
              'Printer name': this.deviceSettings.name
            }
          )
          .catch( this.error )
          .then( this.log )
        this.homey.flow.getTriggerCard('completion_layer_changed').trigger(
          { 
            'Completion layer %': this.printer.job.completion_layer != null ? this.printer.job.completion_layer : 0,
            'Printer name': this.deviceSettings.name
          }
        )
        .catch( this.error )
        .then( this.log )
      }

      if(this.printer.memory.completion_time != this.printer.job.completion_time ){
        this.printer.memory.completion_time = this.printer.job.completion_time;
        this.homey.flow.getTriggerCard('completion_time_changed').trigger( 
            { 
              'Completion time %': this.printer.job.completion_time != null ? this.printer.job.completion_time : 0,
              'Printer name': this.deviceSettings.name
            }
          )
          .catch( this.error )
          .then( this.log )
      }
    }
    
    // Update memory
    this.setJobStart();
    this.printer.memory.state = this.printer.state.cur;
    this.printer.memory.completion_layer = this.printer.job.completion_layer;
    this.printer.memory.completion_time = this.printer.job.completion_time;

    this.setCapabilityValue('printer_state', this.printer.state.cur).catch(error => this.log(error));
    this.setCapabilityValue('job_time', Math.round(this.printer.job.time / 60)).catch(error => this.log(error));
    this.setCapabilityValue('printer_temp_tool', this.printer.temp.hotend.actual).catch(error => this.log(error));
    this.setCapabilityValue('printer_temp_bed', this.printer.temp.bed.actual).catch(error => this.log(error));
    if(this.deviceSettings.hasChamberTempSensor) {
      this.setCapabilityValue('printer_temp_chamber', this.printer.temp.chamber.actual).catch(error => this.log(error));
    }
    this.setCapabilityValue('job_timeleft', this.printer.job.left).catch(error => this.log(error));
    
    this.setCompletionLayerValue();
    this.setCompletionTimeValue();
    
    this.setCapabilityValue('job_layer', this.printer.job.current_layer + " / " + this.printer.job.total_layer).catch(error => this.log(error));
  }

  async refreshInfo(){
    while ( this.refreshingInfo ) {
      //this.log('http://' + this.deviceSettings.url + Data_Keys.urlPrintStats);
      let promise = await this.axiosInstance({
                  method: "get",
                  url: 'http://' + this.deviceSettings.url + Data_Keys.urlQuery,
                  data: "",
                  timeout: 5 * 1000,
              })
              .then((response) => {
                  if(response.status == 200){
                    //this.log(response.data.result);
                    this.printer.state.cur = response.data.result.status.print_stats.state;
                    this.printer.job.filename = response.data.result.status.print_stats.filename;
                    this.printer.job.time = response.data.result.status.print_stats.print_duration;

                    this.printer.job.total_layer = response.data.result.status.print_stats.info.total_layer != null ? response.data.result.status.print_stats.info.total_layer : 1;
                    this.printer.job.current_layer = response.data.result.status.print_stats.info.current_layer != null ? response.data.result.status.print_stats.info.current_layer : 0;
                    this.printer.job.completion_layer = Math.round(this.printer.job.current_layer * 100 / this.printer.job.total_layer);

                    this.printer.temp.hotend.actual = response.data.result.status.extruder.temperature != null ? response.data.result.status.extruder.temperature : 0;
                    this.printer.temp.hotend.target = response.data.result.status.extruder.target != null ? response.data.result.status.extruder.target : 0;

                    this.printer.temp.bed.actual = response.data.result.status.heater_bed.temperature != null ? response.data.result.status.heater_bed.temperature : 0;
                    this.printer.temp.bed.target = response.data.result.status.heater_bed.target != null ? response.data.result.status.heater_bed.target : 0;

                    this.printer.temp.chamber.actual = response.data.result.status["temperature_sensor chamber_temp"].temperature != null ? response.data.result.status["temperature_sensor chamber_temp"].temperature : 0;
                  }
                  else{
                    this.log("Device not reachable");
                    //this.log(response);
                  };
              })
              .catch((error) => {
                  this.log(error);
              });

      if(this.printer.job.filename != null && this.printer.job.filename != ""){
        promise = await this.axiosInstance({
              method: "get",
              url: 'http://' + this.deviceSettings.url + Data_Keys.urlMetadataFilename + this.printer.job.filename,
              data: "",
              timeout: 5 * 1000,
          })
          .then((response) => {
              if(response.status == 200){
                //this.log(response.data.result);
                this.printer.job.estimate = Math.round(response.data.result.estimated_time);
                this.printer.job.left = Math.round((this.printer.job.estimate - this.printer.job.time) / 60);
                this.printer.job.completion_time = Math.round((this.printer.job.time * 100) / this.printer.job.estimate);
              }
              else{
                this.log("Device not reachable");
                //this.log(response);
              };
          })
          .catch((error) => {
              this.log(error);
        });
      };

      this.updateCapabilities();

      await delay( this.deviceSettings.pollingRate != null ? parseInt(this.deviceSettings.pollingRate)*1000 : 30*1000);
      //this.log(this.printer);
    }
  }
}



module.exports = PrinterDevice;
