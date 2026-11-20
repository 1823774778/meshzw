// wifiroamd.mjs -- 唯一入口，只做组装与启动，越薄越好。
// 对应原版文件末尾的 main(); 调用。
import { main } from './daemon/core.mjs';

await main();
