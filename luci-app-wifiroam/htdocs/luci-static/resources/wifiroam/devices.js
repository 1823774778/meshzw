/*
 * wifiroam LuCI frontend - readable rewrite of luci-app-wifiroam 0.261115.15302.
 *
 * Only the dense one-line layout was re-laid-out (indentation, line breaks,
 * section notes). No logic, text, class name, element id, ubus call,
 * parameter, polling interval or button action was changed.
 */
'require baseclass';
return baseclass.extend({
    // Hostname pattern -> vendor name.
    NAME_VENDOR: [
        [
            /iphone|ipad|ipod|macbook|imac|mac[- ]?(mini|pro|studio|air)|homepod|apple[- ]?tv/,
            'Apple',
        ],
        [
            /redmi|poco|xiaomi|mijia|mi[- ]?smart[- ]?speaker|smartcamera|mi[- ]?(mix|note|pad|tv|band)|\bmi[- ]?\d|小爱/,
            'Xiaomi',
        ],
        [/galaxy|samsung|\bsm-[a-z]\d/, 'Samsung'],
        [/honor/, 'HONOR'],
        [/huawei|mate[- ]?\d|matebook/, 'Huawei'],
        [/oneplus/, 'OnePlus'],
        [/realme/, 'realme'],
        [/iqoo|vivo/, 'vivo'],
        [/oppo/, 'OPPO'],
        [/meizu/, 'Meizu'],
        [/redmagic|nubia/, 'Nubia'],
        [/pixel|chromecast|\bnest\b|google/, 'Google'],
        [/motorola|moto[- ]/, 'Motorola'],
        [/xperia|playstation|\bps[45]\b|sony/, 'Sony'],
        [/thinkpad|thinkcentre|legion|lenovo/, 'Lenovo'],
        [/\bdell\b|\bxps\b|latitude|inspiron|precision/, 'Dell'],
        [/elitebook|pavilion|\benvy\b|\bomen\b|\bhp\b/, 'HP'],
        [/zenbook|vivobook|\brog\b|asus/, 'ASUS'],
        [/surface/, 'Microsoft'],
        [/kindle|fire[- ]?(tv|hd)|echo[- ]|amazon/, 'Amazon'],
        [/raspberry/, 'Raspberry Pi'],
        [/esp32|esp8266|espressif/, 'Espressif'],
        [/tuya/, 'Tuya'],
        [
            /\baqara\b|\blumi\b|acpartner|sensor[-_]?(ht|cube|motion|magnet|wleak)|ctrl[-_]?(86plug|dualchn|ln|neutral)/,
            'Aqara',
        ],
        [/hikvision|dnvrs-webs|\bds-\d/, 'Hikvision'],
        [/epson/, 'Epson'],
        [/\barlo\b/, 'Arlo'],
        [/eufy/, 'Eufy'],
        [/d-?link|mydlink/, 'D-Link'],
        [/xiaoyi/, 'Xiaoyi'],
        [/philips[- ]?hue/, 'Philips Hue'],
        [/lifx/, 'LIFX'],
        [/netatmo/, 'Netatmo'],
        [/withings/, 'Withings'],
        [/tp[- ]?link|\bkasa\b/, 'TP-Link'],
        [/yeelight/, 'Yeelight'],
        [/diskstation|synology/, 'Synology'],
        [/qnap/, 'QNAP'],
        [/roku/, 'Roku'],
        [/\blg\b|webos/, 'LG'],
        [/hisense/, 'Hisense'],
        [/\btcl\b/, 'TCL'],
    ],
    // Hostname pattern -> device kind.
    NAME_KIND: [
        [
            /macbook|imac|mac-?mini|thinkpad|notebook|laptop|desktop|windows|surface|\bpc\b|电脑|工作站/,
            'laptop',
        ],
        [/ipad|tablet|\bpad\b|平板/, 'tablet'],
        [/appletv|chromecast|firetv|fire-tv|bravia|smarttv|smart-tv|\btv\b|电视|roku/, 'tv'],
        [/synology|qnap|asustor|diskstation|nas\b|server|群晖|存储/, 'nas'],
        [
            /\bcam\b|\bipc\b|监控|摄像|camera|webcam|hikvision|dnvrs|\bds-\d|arlo|eufy|xiaoyi/,
            'camera',
        ],
        [/print|打印机|scanner|扫描仪|epson/, 'printer'],
        [/speaker|soundbar|音箱|音响|homepod|echo|小爱|\bsound\b/, 'speaker'],
        [/iphone|android|galaxy|pixel|redmi|mi-?\d|小米|华为|honor|手机|phone/, 'phone'],
        [/router|gateway|mesh|access.?point|\bap-?\d|网关|路由/, 'router'],
        [
            /sensor|plug|switchbot|zigbee|\biot\b|传感器|插座|aqara|\blumi\b|acpartner|mijia|philips[- ]?hue|lifx|netatmo|withings|\bkasa\b|yeelight/,
            'iot',
        ],
    ],
    // Vendor name pattern -> device kind.
    VENDOR_KIND: [
        [
            /hikvision|dahua|ezviz|reolink|uniview|axis comm|amcrest|annke|lorex|vivotek|geovision|mobotix|hanwha|arlo|wyze|ring llc|tapo|xiaoyi|eufy/,
            'camera',
        ],
        [
            /canon|epson|brother|xerox|ricoh|kyocera|lexmark|zebra|datalogic|konica|minolta|seiko epson/,
            'printer',
        ],
        [
            /sonos|bose|harman|\bjbl\b|\bakg\b|denon|yamaha|sennheiser|audio-technica|technics|onkyo|marantz|bang & olufsen|klipsch|devialet|marshall/,
            'speaker',
        ],
        [
            /synology|qnap|asustor|buffalo|terra.?master|western digital|seagate|netapp|drobo|\biodata\b|readynas/,
            'nas',
        ],
        [
            /espressif|tuya|itead|sonoff|silicon labs|nordic|broadlink|signify|philips|raspberry pi|arduino|shelly|aqara|lumi|yeelight|meross|ecobee|nest labs|ecovacs|irobot|roborock|dreame|switchbot|wemo|belkin|govee|nanoleaf|fibaro|aeotec|midea|gree|haier|lifx|netatmo|sensibo|withings/,
            'iot',
        ],
        [/hisense|skyworth|changhong|vestel|tcl|sharp|panasonic|roku|konka/, 'tv'],
        [
            /intel|dell|lenovo|asustek|asus|gigabyte|micro-star|\bmsi\b|hewlett|razer|supermicro|fujitsu|toshiba|clevo|compal|quantum/,
            'laptop',
        ],
        [
            /samsung|xiaomi|oppo|vivo|honor|huawei|oneplus|realme|motorola|google|meizu|zte|nokia|tcl communication|wiko|\bhtc\b|blackberry|nubia|smartisan/,
            'phone',
        ],
        [
            /ubiquiti|mikrotik|tp-link|netgear|ruijie|\bh3c\b|tenda|d-link|dlink|cisco|aruba|meraki|linksys|fortinet|juniper|zyxel|palo alto|sophos|check point|draytek|totolink|mercusys|netis|comfast|wavlink|gl inet|gl technologies|edimax|trendnet|avm gmbh|fritz/,
            'router',
        ],
    ],
    nameVendor: function (s) {
        s = (s || '').toLowerCase();
        if (!s) return null;
        for (var i = 0; i < this.NAME_VENDOR.length; i++)
            if (this.NAME_VENDOR[i][0].test(s)) return this.NAME_VENDOR[i][1];
        return null;
    },
    nameKind: function (s) {
        s = (s || '').toLowerCase();
        if (!s) return null;
        for (var i = 0; i < this.NAME_KIND.length; i++)
            if (this.NAME_KIND[i][0].test(s)) return this.NAME_KIND[i][1];
        return null;
    },
    vendorKind: function (name) {
        var s = (name || '').toLowerCase();
        if (!s) return null;
        for (var i = 0; i < this.VENDOR_KIND.length; i++)
            if (this.VENDOR_KIND[i][0].test(s)) return this.VENDOR_KIND[i][1];
        return null;
    },
    kindFor: function (vendor, name) {
        return this.nameKind(name) || this.vendorKind(vendor);
    },
});
