export class Data_Keys {
    static stateInit = "init";
    static stateStandby = "standby";
    static statePaused = "paused";
    static statePrinting = "printing";
    static stateComplete = "complete";
    static stateError = "error";
    static stateCancelled = "cancelled";
    
    static urlQuery = "/printer/objects/query?print_stats&extruder=target,temperature&heater_bed=target,temperature&temperature_sensor+chamber_temp=temperature"
    static urlMetadataFilename = "/server/files/metadata?filename=";
    static urlPauseJob = "/printer/print/pause";
    static urlResumeJob = "/printer/print/resume";
};