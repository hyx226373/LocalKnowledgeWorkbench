// yauzl 在加载时会 require('zlib')。xlsx 走 exceljs 的浏览器构建，这里只让模块能加载。
function passthrough(buffer, callback) {
  if (typeof callback === 'function') callback(null, buffer);
  return buffer;
}

module.exports = {
  inflateRaw: passthrough,
  inflate: passthrough,
  deflateRaw: passthrough,
  unzip: passthrough,
  constants: {},
};
