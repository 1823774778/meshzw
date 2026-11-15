/*
 * 设备图标库：拓扑节点与终端卡片共用同一套 SVG 图形，
 * 保证「终端名字前的图标」与拓扑里的图标完全一致。
 * 支持 laptop / tablet / phone / tv / nas / camera / printer /
 *      speaker / router / wired / iot / ac / fridge / washer / generic
 */
'require baseclass';

var NS = 'http://www.w3.org/2000/svg';

function n(tag, attrs, text) {
	var el = document.createElementNS(NS, tag);
	if (attrs) {
		Object.keys(attrs).forEach(function(k) {
			if (attrs[k] != null) el.setAttribute(k, attrs[k]);
		});
	}
	if (text != null) el.textContent = text;
	return el;
}

return baseclass.extend({
	draw: function(g, x, y, kind) {
		var box = { fill: '#eceff1', stroke: '#546e7a', 'stroke-width': 1.6 };
		var plate = { fill: '#cfd8dc', stroke: '#78909c', 'stroke-width': 1.2 };
		var edge = box.stroke;

		switch (kind) {
		case 'laptop':
			g.appendChild(n('rect', {
				x: x - 10, y: y - 5, width: 20, height: 12, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': box['stroke-width']
			}));
			g.appendChild(n('path', {
				d: 'M ' + (x - 13) + ' ' + (y + 9) + ' L ' + (x + 13) + ' ' + (y + 9) +
				   ' L ' + (x + 10) + ' ' + (y + 5) + ' L ' + (x - 10) + ' ' + (y + 5) + ' Z',
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': plate['stroke-width']
			}));
			break;
		case 'phone':
			g.appendChild(n('rect', {
				x: x - 6.5, y: y - 11, width: 13, height: 22, rx: 3,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('line', {
				x1: x - 2.5, y1: y - 8, x2: x + 2.5, y2: y - 8,
				stroke: '#78909c', 'stroke-width': 1.3
			}));
			g.appendChild(n('circle', { cx: x, cy: y + 8, r: 1.3, fill: '#78909c', stroke: 'none' }));
			break;
		case 'tablet':
			g.appendChild(n('rect', {
				x: x - 9, y: y - 11, width: 18, height: 22, rx: 2.5,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('line', {
				x1: x - 4, y1: y + 8, x2: x + 4, y2: y + 8,
				stroke: '#78909c', 'stroke-width': 1.3
			}));
			break;
		case 'tv':
			g.appendChild(n('rect', {
				x: x - 11, y: y - 9, width: 22, height: 14, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('path', {
				d: 'M ' + (x - 4) + ' ' + (y + 5) + ' L ' + (x + 4) + ' ' + (y + 5) +
				   ' L ' + (x + 6) + ' ' + (y + 9) + ' L ' + (x - 6) + ' ' + (y + 9) + ' Z',
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': plate['stroke-width']
			}));
			break;
		case 'nas':
			[-10, -3, 4].forEach(function(dy) {
				g.appendChild(n('rect', {
					x: x - 9, y: y + dy, width: 18, height: 6, rx: 1.5,
					fill: box.fill, stroke: box.stroke, 'stroke-width': 1.5
				}));
				g.appendChild(n('circle', { cx: x + 6, cy: y + dy + 3, r: 1.2, fill: '#43a047', stroke: 'none' }));
			});
			break;
		case 'speaker':
			g.appendChild(n('rect', {
				x: x - 7, y: y - 10, width: 14, height: 20, rx: 7,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('circle', {
				cx: x, cy: y - 3.5, r: 2.6,
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1
			}));
			g.appendChild(n('circle', { cx: x, cy: y + 4.5, r: 1.5, fill: '#78909c', stroke: 'none' }));
			break;
		case 'camera':
			g.appendChild(n('rect', {
				x: x - 9, y: y - 6, width: 18, height: 12, rx: 2.5,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('circle', {
				cx: x + 1, cy: y, r: 3.4,
				fill: 'none', stroke: '#546e7a', 'stroke-width': 1.6
			}));
			g.appendChild(n('path', {
				d: 'M ' + (x - 9) + ' ' + (y - 6) + ' L ' + (x - 5) + ' ' + (y - 10) +
				   ' L ' + (x + 1) + ' ' + (y - 10) + ' L ' + (x + 4) + ' ' + (y - 6),
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1
			}));
			break;
		case 'printer':
			g.appendChild(n('rect', {
				x: x - 10, y: y - 2, width: 20, height: 9, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('rect', {
				x: x - 6, y: y - 9, width: 12, height: 7, rx: 1,
				fill: '#fff', stroke: '#78909c', 'stroke-width': 1.3
			}));
			g.appendChild(n('rect', {
				x: x - 6, y: y + 5, width: 12, height: 6, rx: 1,
				fill: '#fff', stroke: '#78909c', 'stroke-width': 1.3
			}));
			break;
		case 'router':
			g.appendChild(n('rect', {
				x: x - 10, y: y - 3, width: 20, height: 8, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			[-6, -2, 2, 6].forEach(function(dx) {
				g.appendChild(n('circle', { cx: x + dx, cy: y + 1, r: 1.2, fill: '#78909c', stroke: 'none' }));
			});
			g.appendChild(n('line', {
				x1: x - 4, y1: y - 3, x2: x - 7, y2: y - 10,
				stroke: box.stroke, 'stroke-width': 1.5, 'stroke-linecap': 'round'
			}));
			g.appendChild(n('line', {
				x1: x + 4, y1: y - 3, x2: x + 7, y2: y - 10,
				stroke: box.stroke, 'stroke-width': 1.5, 'stroke-linecap': 'round'
			}));
			break;
		case 'wired':
			g.appendChild(n('rect', {
				x: x - 8, y: y - 6, width: 16, height: 12, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			[-5, -1, 3, 7].forEach(function(dx) {
				g.appendChild(n('rect', {
					x: x + dx - 1.5, y: y - 10, width: 3, height: 5, rx: 1,
					fill: plate.fill, stroke: '#90a4ae', 'stroke-width': 0.8
				}));
			});
			break;
		case 'ac':
			/* 壁挂空调：横向出风口 + 三条送风曲线 */
			g.appendChild(n('rect', {
				x: x - 12, y: y - 7, width: 24, height: 10, rx: 2.5,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('line', {
				x1: x - 8, y1: y + 3, x2: x + 8, y2: y + 3,
				stroke: '#90a4ae', 'stroke-width': 1.2
			}));
			[-6, 0, 6].forEach(function(dx) {
				g.appendChild(n('path', {
					d: 'M ' + (x + dx) + ' ' + (y + 5) + ' q 2 3 0 6',
					fill: 'none', stroke: '#4fc3f7', 'stroke-width': 1.4,
					'stroke-linecap': 'round'
				}));
			});
			break;
		case 'fridge':
			/* 冰箱：双门竖柜 + 门把手 */
			g.appendChild(n('rect', {
				x: x - 7, y: y - 12, width: 14, height: 24, rx: 2.5,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('line', {
				x1: x - 7, y1: y - 2, x2: x + 7, y2: y - 2,
				stroke: '#90a4ae', 'stroke-width': 1.2
			}));
			g.appendChild(n('line', {
				x1: x + 3, y1: y - 7, x2: x + 3, y2: y - 4,
				stroke: '#78909c', 'stroke-width': 1.6, 'stroke-linecap': 'round'
			}));
			g.appendChild(n('line', {
				x1: x + 3, y1: y + 1, x2: x + 3, y2: y + 4,
				stroke: '#78909c', 'stroke-width': 1.6, 'stroke-linecap': 'round'
			}));
			break;
		case 'washer':
			/* 洗衣机：方形机身 + 圆形滚筒门 */
			g.appendChild(n('rect', {
				x: x - 10, y: y - 11, width: 20, height: 22, rx: 2.5,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('circle', {
				cx: x, cy: y + 2, r: 6,
				fill: plate.fill, stroke: box.stroke, 'stroke-width': 1.4
			}));
			g.appendChild(n('circle', { cx: x - 5, cy: y - 7, r: 1.1, fill: '#43a047', stroke: 'none' }));
			break;
		case 'iot':
			g.appendChild(n('rect', {
				x: x - 7, y: y - 7, width: 14, height: 14, rx: 2,
				fill: box.fill, stroke: box.stroke, 'stroke-width': 1.6
			}));
			g.appendChild(n('rect', {
				x: x - 3, y: y - 3, width: 6, height: 6, rx: 1,
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1
			}));
			[-4, 0, 4].forEach(function(d) {
				g.appendChild(n('line', {
					x1: x + d, y1: y - 10.5, x2: x + d, y2: y - 7,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
				g.appendChild(n('line', {
					x1: x + d, y1: y + 7, x2: x + d, y2: y + 10.5,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
				g.appendChild(n('line', {
					x1: x - 10.5, y1: y + d, x2: x - 7, y2: y + d,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
				g.appendChild(n('line', {
					x1: x + 7, y1: y + d, x2: x + 10.5, y2: y + d,
					stroke: box.stroke, 'stroke-width': 1.3
				}));
			});
			break;
		default:
			g.appendChild(n('circle', {
				cx: x, cy: y - 4, r: 3.2,
				fill: plate.fill, stroke: plate.stroke, 'stroke-width': 1.2
			}));
			g.appendChild(n('path', {
				d: 'M ' + (x - 7) + ' ' + (y + 9) + ' Q ' + x + ' ' + (y - 1) + ' ' + (x + 7) + ' ' + (y + 9),
				fill: 'none', stroke: edge, 'stroke-width': 1.6, 'stroke-linecap': 'round'
			}));
		}
	}
});
