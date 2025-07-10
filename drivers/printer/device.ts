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
  triggers: any;

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
        previous_layer_start: Date.now(),
        previous_layer_time: 0,
        completion_layer: 0,
        estimate: 0,
        time: 0,
        left: 0,
        completion_time: 0
      },
      memory: {
        firstInit: true,
        chamber_temp: 0,
        current_layer: 0,
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
    this.registerCapabilityListener("job_cancelled", this.setJobError.bind(this));
    this.registerCapabilityListener("job_error", this.setJobCancelled.bind(this));    
    this.registerCapabilityListener("job_pause", this.setJobPause.bind(this));
    this.registerCapabilityListener("job_resume", this.setJobResume.bind(this));

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
    if(this.getCapabilities().find(x => x == "current_layer") == null) { this.addCapability("current_layer");}
    if(this.getCapabilities().find(x => x == "job_completion_layer") == null) { this.addCapability("job_completion_layer");}
    if(this.getCapabilities().find(x => x == "job_completion_time") == null) { this.addCapability("job_completion_time");}
    if(this.getCapabilities().find(x => x == "job_layer") == null) { this.addCapability("job_layer");}
    if(this.getCapabilities().find(x => x == "job_pause") == null) { this.addCapability("job_pause");}
    if(this.getCapabilities().find(x => x == "job_resume") == null) { this.addCapability("job_resume");}
    if(this.getCapabilities().find(x => x == "job_time") == null) { this.addCapability("job_time");}
    if(this.getCapabilities().find(x => x == "job_timeleft") == null) { this.addCapability("job_timeleft");}
    if(this.getCapabilities().find(x => x == "previous_layer_time") == null) { this.addCapability("previous_layer_time");}
    if(this.getCapabilities().find(x => x == "previous_layer") == null) { this.addCapability("previous_layer");}
    if(this.getCapabilities().find(x => x == "printer_state") == null) { this.addCapability("printer_state");}
    if(this.getCapabilities().find(x => x == "printer_temp_bed") == null) { this.addCapability("printer_temp_bed");}
    if(this.getCapabilities().find(x => x == "printer_temp_tool") == null) { this.addCapability("printer_temp_tool");}
    if(this.getCapabilities().find(x => x == "total_layer") == null) { this.addCapability("total_layer");}

    // Optionnal Capabilities
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

  async checkPrinterIsCancelled() {
    return (this.printer.state.cur == Data_Keys.stateCancelled) ? true : false;
  }

  async checkPrinterIsInError() {
    return (this.printer.state.cur == Data_Keys.stateError) ? true : false;
  }

  async getPrintTime() {
    return this.printer.job.print_time;
  }

  async getPrintTimeLeft() {
    return this.printer.job.print_time_left;
  }

  async setJobStart(){
    this.log("Job started");
  }

  async setJobHold(){
    this.log("Job hold");
  }

  async setJobComplete(){
    this.log("Job complete");
  }

  async setJobError(){
    this.log("Job in error");
  }

  async setJobCancelled(){
    this.log("Job cancelled");
  }

  // Action by user possible
  async setJobPause(){
    let promise = await this.axiosInstance({
        method: "post",
        url: 'http://' + this.deviceSettings.url + Data_Keys.urlPauseJob,
        data: {
          "jsonrpc": "2.0",
          "method": "printer.print.pause",
          "id": 4564
        },
        timeout: 5 * 1000,
      })
      .then((response) => {
          //this.log(response);
      })
      .catch((error) => {
          this.log(error);
      });
  }

  // Action by user possible
  async setJobResume(){
    let promise = await this.axiosInstance({
        method: "post",
        url: 'http://' + this.deviceSettings.url + Data_Keys.urlResumeJob,
        data: {
          "jsonrpc": "2.0",
          "method": "printer.print.resume",
          "id": 1465
        },
        timeout: 5 * 1000,
      })
      .then((response) => {
          //this.log(response);
      })
      .catch((error) => {
          this.log(error);
      });
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
        switch (this.printer.state.cur) {
         case Data_Keys.statePrinting:
            this.homey.flow.getDeviceTriggerCard('job_start').trigger(this);
            this.setJobStart();     
          case Data_Keys.statePaused:
            this.homey.flow.getDeviceTriggerCard('job_hold').trigger(this);
            this.setJobHold(); 
          case Data_Keys.stateComplete:
          case Data_Keys.stateStandby:
            if(this.printer.memory.state != Data_Keys.stateStandby && this.printer.memory.state != Data_Keys.stateComplete){
              this.homey.flow.getDeviceTriggerCard('job_complete').trigger(this);
              this.setJobComplete();
            }
          case Data_Keys.stateError:
            this.homey.flow.getDeviceTriggerCard('job_error').trigger(this);
            this.setJobError();
          case Data_Keys.stateCancelled:
            this.homey.flow.getDeviceTriggerCard('job_cancelled').trigger(this);
            this.setJobCancelled();
          
          this.printer.memory.state = this.printer.state.cur;
        }
      }

      if(this.printer.memory.current_layer != this.printer.job.current_layer ){
        this.printer.memory.current_layer = this.printer.job.current_layer;
        this.printer.job.previous_layer_time = Math.floor((Date.now() - this.printer.job.previous_layer_start) / 1000),
        this.printer.job.previous_layer_start = Date.now();
      }

      if(this.getCapabilities().find(x => x == "printer_temp_chamber") != null){
        if(this.printer.memory.chamber_temp != this.printer.temp.chamber.actual ){
          this.printer.memory.chamber_temp = this.printer.temp.chamber.actual;
          this.homey.flow.getDeviceTriggerCard('chamber_temp_changed').trigger(this,
              { 
                'Chamber temperature': this.printer.temp.chamber.actual != null ? this.printer.temp.chamber.actual : 0,
                'Chamber target': this.printer.temp.chamber.target != null ? this.printer.temp.chamber.target : 0,
              }
            )
            .catch( this.error )
            .then( this.log )
        }
      }      

      if(this.printer.memory.completion_layer != this.printer.job.completion_layer ){
        this.printer.memory.completion_layer = this.printer.job.completion_layer;
        this.homey.flow.getDeviceTriggerCard('completion_layer_changed').trigger(this, 
            { 
              'Completion layer %': this.printer.job.completion_layer != null ? this.printer.job.completion_layer : 0
            }
          )
          .catch( this.error )
          .then( this.log )
      }

      if(this.printer.memory.completion_time != this.printer.job.completion_time ){
        this.printer.memory.completion_time = this.printer.job.completion_time;
        this.homey.flow.getDeviceTriggerCard('completion_time_changed').trigger( this,
            { 
              'Completion time %': this.printer.job.completion_time != null ? this.printer.job.completion_time : 0
            }
          )
          .catch( this.error )
          .then( this.log )
      }
    }
    
    // Update memory
    this.printer.memory.state = this.printer.state.cur;
    if(this.getCapabilities().find(x => x == "printer_temp_chamber") != null){
      this.printer.memory.chamber_temp = this.printer.job.chamber_temp;
    }
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

    this.setCapabilityValue('previous_layer', this.printer.job.current_layer > 1 ? (this.printer.job.current_layer - 1) : 0).catch(error => this.log(error));    
    this.setCapabilityValue('current_layer', this.printer.job.current_layer).catch(error => this.log(error));
    this.setCapabilityValue('total_layer', this.printer.job.total_layer).catch(error => this.log(error));
    this.setCapabilityValue('previous_layer_time', this.printer.job.previous_layer_time).catch(error => this.log(error));

    
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
                    this.printer.temp.chamber.target = response.data.result.status["temperature_fan chamber_fan"].target != null ? response.data.result.status["temperature_fan chamber_fan"].target : 0;
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

      await delay( this.deviceSettings.pollingRate != null ? this.deviceSettings.pollingRate*1000 : 30*1000);
      //this.log(this.printer);
    }
  }
}



module.exports = PrinterDevice;
