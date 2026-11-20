/**
 * drpy2 Node-vm 装载器（由 tvbox spider.ts 拼接执行）。
 *
 * drpy2.js 是 QuickJS/ESM 形态，宿主注入式架构：
 *  - 头部 import（cheerio/crypto-js/jsencrypt/模板/gbk）→ 由 spider.ts 把依赖库
 *    预先装载为沙箱全局（cheerio/CryptoJS/JSEncrypt/模板/gbkTool/Uri），装载时剥 ESM 壳；
 *  - 主体引用的宿主函数 → 沙箱全局注入（同名实现）：
 *      req(url, obj) → {content, headers, status}（同步代理，Atomics 桥）
 *      joinUrl(from, now) / 基础 pdfh/pdfa/pd / pdfl / getCryptoJS()
 *  - 尾部 export default {...} → 剥壳后收集为 globalThis.DRPY。
 *
 * 本文件作为「依赖库装载器」被执行：spider.ts 读 drpy2.js 剥掉 import/export 行，
 * 拼在本文件之后一起编译执行；约定本文件内不出现反引号模板。
 */
