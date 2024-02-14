export class Data_Keys {
    static stateInit = "init";
    static stateStandby = "standby";
    static statePaused = "paused";
    static statePrinting = "printing";
    static stateComplete = "complete";
    static stateError = "error";
    
    static urlPrintStats = "/printer/objects/query?print_stats";
    static urlQueryExtruder = "/printer/objects/query?extruder";
    static urlQueryBed = "/printer/objects/query?heater_bed";
    static urlMetadataFilename = "/server/files/metadata?filename=";
};