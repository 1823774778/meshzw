/*
 * 设备型号/类型库：把「厂商名 + 主机名线索」映射为拓扑图标类别。
 * 主机名线索优先（iPhone17,2、Redmi-K60 这类默认名比 OUI 更能说明类型），
 * 没有名字线索时再按厂商主营产品归类。
 * 类别需与拓扑视图 glyph() 支持的图标一致：
 *   laptop / tablet / phone / tv / nas / camera / printer / speaker / router / iot
 */
'require baseclass';
return baseclass.extend({
	/* 主机名/设备名关键字 → 类别（顺序敏感：先命中者优先） */
	NAME_KIND: [
		[/macbook|imac|mac-?mini|thinkpad|notebook|laptop|desktop|windows|surface|\bpc\b|电脑|工作站/, 'laptop'],
		[/ipad|tablet|\bpad\b|平板/, 'tablet'],
		[/appletv|chromecast|firetv|fire-tv|bravia|smarttv|smart-tv|\btv\b|电视|roku/, 'tv'],
		[/synology|qnap|asustor|diskstation|nas\b|server|群晖|存储/, 'nas'],
		[/\bcam\b|\bipc\b|监控|摄像|camera|webcam/, 'camera'],
		[/print|打印机|scanner|扫描仪/, 'printer'],
		[/speaker|soundbar|音箱|音响|homepod|echo|小爱|\bsound\b/, 'speaker'],
		[/iphone|android|galaxy|pixel|redmi|mi-?\d|小米|华为|honor|手机|phone/, 'phone'],
		[/router|gateway|mesh|access.?point|\bap-?\d|网关|路由/, 'router'],
		[/sensor|plug|switchbot|zigbee|\biot\b|传感器|插座/, 'iot'],
	],

	/* 厂商名关键字 → 类别（按主营产品归类，从专到宽） */
	VENDOR_KIND: [
		[/hikvision|dahua|ezviz|reolink|uniview|axis comm|amcrest|annke|lorex|vivotek|geovision|mobotix|hanwha|arlo|wyze|ring llc|tapo/, 'camera'],

		[/canon|epson|brother|xerox|ricoh|kyocera|lexmark|zebra|datalogic|konica|minolta|seiko epson/, 'printer'],

		[/sonos|bose|harman|\bjbl\b|\bakg\b|denon|yamaha|sennheiser|audio-technica|technics|onkyo|marantz|bang & olufsen|klipsch|devialet|marshall/, 'speaker'],

		[/synology|qnap|asustor|buffalo|terra.?master|western digital|seagate|netapp|drobo|\biodata\b|readynas/, 'nas'],

		[/espressif|tuya|itead|sonoff|silicon labs|nordic|broadlink|signify|philips|raspberry pi|arduino|shelly|aqara|lumi|yeelight|meross|ecobee|nest labs|ecovacs|irobot|roborock|dreame|switchbot|eufy|wemo|belkin|govee|nanoleaf|fibaro|aeotec/, 'iot'],

		[/hisense|skyworth|changhong|vestel|tcl|sharp|panasonic|roku/, 'tv'],

		[/intel|dell|lenovo|asustek|asus|gigabyte|micro-star|\bmsi\b|hewlett|razer|supermicro|fujitsu|toshiba|clevo|compal|quantum/, 'laptop'],

		[/samsung|xiaomi|oppo|vivo|honor|huawei|oneplus|realme|motorola|google|meizu|zte|nokia|tcl communication|wiko|\bhtc\b|blackberry|nubia|smartisan/, 'phone'],

		[/ubiquiti|mikrotik|tp-link|netgear|ruijie|\bh3c\b|tenda|d-link|dlink|cisco|aruba|meraki|linksys|fortinet|juniper|zyxel|palo alto|sophos|check point|draytek|totolink|mercusys|netis|comfast|wavlink|gl inet|gl technologies|edimax|trendnet|avm gmbh|fritz/, 'router'],
	],

	nameKind: function(s) {
		s = (s || '').toLowerCase();
		if (!s) return null;
		for (var i = 0; i < this.NAME_KIND.length; i++)
			if (this.NAME_KIND[i][0].test(s))
				return this.NAME_KIND[i][1];
		return null;
	},

	vendorKind: function(name) {
		var s = (name || '').toLowerCase();
		if (!s) return null;
		for (var i = 0; i < this.VENDOR_KIND.length; i++)
			if (this.VENDOR_KIND[i][0].test(s))
				return this.VENDOR_KIND[i][1];
		return null;
	},

	/* 主机名线索优先，其次厂商归类；都没有则返回 null 由调用方兜底 */
	kindFor: function(vendor, name) {
		return this.nameKind(name) || this.vendorKind(vendor);
	},
});
