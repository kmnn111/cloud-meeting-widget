/* 打包前清空 dist：只保留当次构建产物，避免旧版本安装包/映射文件堆积 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, 'dist');
if (fs.existsSync(dist)) {
  for (const f of fs.readdirSync(dist)) {
    fs.rmSync(path.join(dist, f), { recursive: true, force: true });
  }
}
console.log('[clean-dist] dist 已清空，开始全新打包');
