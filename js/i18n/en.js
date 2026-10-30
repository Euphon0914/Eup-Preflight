// 英文词典：合并各部分（键是中文原文，值是英文）。翻译机制见 js/core/i18n.js
import ui from './en-ui.js';
import tech from './en-tech.js';
import occlusion from './en-occlusion.js';
import cover from './en-cover.js';
import summary from './en-summary.js';
import config from './en-config.js';

export default { ...ui, ...tech, ...occlusion, ...cover, ...summary, ...config };
