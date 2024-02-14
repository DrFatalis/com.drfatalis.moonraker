Moonraker is a Python 3 based web server that exposes APIs with which client applications may use to interact with the 3D printing firmware Klipper.
This application will allow you to get klipper sensor and status via moonraker API. 

In Homey, create one or multiple printer device. Each of them needs the server url with port if needed:
    eg. http://192.168.0.2:7125


For the "Completion (layer)" capability to be working, make sure that your slicer is injecting layer informations (cf. set_print_stats_info in klipper) 

History:
    v1.1.2: May require your printer device to be recreated

Please report your issues here: https://github.com/DrFatalis/com.drfatalis.moonraker/issues

That's it !
